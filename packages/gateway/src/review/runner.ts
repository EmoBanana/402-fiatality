/**
 * AI spend review (SPEC §5.4): one running review per paused tab. The evidence (alarm, the agent's task, up to
 * 25 recent vouchers with request/response excerpts) goes to `ctx.ai.reviewSpend`, whose debate streams out as
 * `review.message`. Verdicts: resume -> active; void -> void the named vouchers of this tab that are still
 * unsettled, then resume; freeze -> frozen; escalate (confidence < 0.6, error, 45 s timeout) -> stays paused
 * until a human decides (POST /api/reviews/:id/decide or POST /api/tabs/:id/resume|freeze).
 */
import {
  newId,
  type ReviewDecisionDTO,
  type ReviewDTO,
  type ReviewFault,
  type ReviewMessageDTO,
  type ReviewVerdict,
  type TabDTO,
  type VoucherDTO,
} from "@p402/shared";
import { z } from "zod";
import type { AppContext, SpendReviewInput, SpendReviewResult, SpendReviewVoucher } from "../context";
import { kvDelete, kvGet, kvSet, parseJson, stmt, tx } from "../db/db";
import { alarmDTO, getTabDTO, reviewDTO, voucherDTO, type AlarmRow, type ReviewRow, type VoucherRow } from "../db/dto";
import { badRequest, conflict, notFound } from "../http/errors";
import { announceTab, getTabRow, resolveTabAlarms, transitionTab } from "../tabs/state";

export const REVIEW_TIMEOUT_MS = 45_000;
/** Below this the AI's verdict is not trusted on its own. */
export const MIN_CONFIDENCE = 0.6;
export const REVIEW_EVIDENCE_LIMIT = 25;
const MAX_MESSAGE_CHARS = 4_000;

export interface ReviewRunner {
  /** Start the AI review for a freshly raised alarm. Null when the tab already has one running. */
  start(tabId: string, alarmId: string): ReviewDTO | null;
  isRunning(tabId: string): boolean;
  isRunningAny(): boolean;
  /** POST /api/reviews/:id/decide */
  decide(reviewId: string, decision: unknown): ReviewDTO;
  /** POST /api/tabs/:id/resume | /freeze */
  humanAction(tabId: string, verdict: "resume" | "freeze"): TabDTO;
  /** Retry-After for agents of a paused tab. */
  retryAfterSec(tabId: string): number;
  /** Resolves once no review is running (tests, shutdown). */
  idle(): Promise<void>;
  /** Abort running reviews and escalate them; later callbacks are ignored. */
  shutdown(): void;
}

export const reviewDecisionSchema = z.object({
  verdict: z.enum(["resume", "void", "freeze"]),
  voidVoucherIds: z.array(z.string().min(1).max(64)).max(100).optional(),
  reason: z.string().trim().min(1).max(500).optional(),
});

/** Defensive parse of the AI service's answer (another package's code: trust, but verify). */
const aiResultSchema = z.object({
  verdict: z.enum(["resume", "void", "freeze", "escalate"]),
  fault: z.enum(["seller", "agent", "none"]).catch("none"),
  confidence: z.number().min(0).max(1).catch(0),
  reason: z.string().catch(""),
  voidVoucherIds: z.array(z.string()).catch([]),
  transcript: z.array(z.object({ role: z.enum(["prosecutor", "defender", "judge"]), content: z.string(), at: z.number() })).catch([]),
  model: z.string().catch(""),
});

interface Decision {
  verdict: ReviewVerdict;
  fault: ReviewFault | null;
  confidence: number | null;
  reason: string;
  voidVoucherIds: string[];
  model: string | null;
  decidedBy: "ai" | "human";
  /** The AI part errored or timed out (status "failed", verdict "escalate"). */
  failed: boolean;
  transcript?: ReviewMessageDTO[];
}

const HUMAN_FAULT: Record<"resume" | "void" | "freeze", ReviewFault> = { resume: "none", void: "seller", freeze: "agent" };
const HUMAN_REASON: Record<"resume" | "void" | "freeze", string> = {
  resume: "A human reviewed the spending and resumed the tab.",
  void: "A human voided the faulty calls and resumed the tab.",
  freeze: "A human froze the tab.",
};

const suggestionKey = (reviewId: string) => `review.suggested_voids.${reviewId}`;

interface Running {
  reviewId: string;
  controller: AbortController;
  promise: Promise<void>;
}

export function createReviewRunner(ctx: AppContext, opts: { timeoutMs?: number } = {}): ReviewRunner {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const running = new Map<string, Running>();
  let closed = false;

  const reviewRow = (id: string) => stmt(ctx.db, "SELECT * FROM reviews WHERE id = ?").get(id) as ReviewRow | undefined;

  function evidence(tabId: string, alarmId: string, reviewId: string): SpendReviewInput {
    const now = ctx.clock.now();
    const tab = getTabDTO(ctx.db, tabId, now);
    const alarm = stmt(ctx.db, "SELECT * FROM alarms WHERE id = ?").get(alarmId) as AlarmRow | undefined;
    if (!tab || !alarm) throw new Error("tab or alarm disappeared");
    const rows = (
      stmt(
        ctx.db,
        "SELECT * FROM vouchers WHERE tab_id = ? AND status != 'pending' ORDER BY created_at DESC, rowid DESC LIMIT ?",
      ).all(tabId, REVIEW_EVIDENCE_LIMIT) as VoucherRow[]
    ).reverse();
    const vouchers: SpendReviewVoucher[] = rows.map((row) => ({
      ...voucherDTO(row),
      requestExcerpt: row.request_excerpt,
      responseExcerpt: row.response_excerpt,
    }));
    // The task of the run behind the latest call (vouchers carry the run id as task), else the tab's latest run.
    const lastTask = rows.at(-1)?.task_id ?? null;
    const task =
      ((lastTask ? stmt(ctx.db, "SELECT task FROM agent_runs WHERE id = ?").get(lastTask) : undefined) as { task: string } | undefined)?.task ??
      (stmt(ctx.db, "SELECT task FROM agent_runs WHERE tab_id = ? ORDER BY created_at DESC LIMIT 1").get(tabId) as { task: string } | undefined)
        ?.task ??
      null;
    return { reviewId, tab, alarm: alarmDTO(alarm), task, vouchers };
  }

  function voidVouchers(tabId: string, reviewId: string, ids: string[]): VoucherDTO[] {
    const voided: VoucherDTO[] = [];
    for (const id of [...new Set(ids)].slice(0, 100)) {
      const changed = stmt(
        ctx.db,
        `UPDATE vouchers SET status = 'voided', void_reason = 'ai_review', review_id = ?
          WHERE id = ? AND tab_id = ? AND status = 'accepted' AND settlement_id IS NULL`,
      ).run(reviewId, id, tabId).changes;
      if (changed > 0) voided.push(voucherDTO(stmt(ctx.db, "SELECT * FROM vouchers WHERE id = ?").get(id) as VoucherRow));
    }
    return voided;
  }

  function apply(review: ReviewRow, d: Decision): ReviewDTO {
    let voided: VoucherDTO[] = [];
    let tabMoved = false;
    tx(ctx.db, () => {
      if (d.verdict === "void") voided = voidVouchers(review.tab_id, review.id, d.voidVoucherIds);
      if (d.verdict === "resume" || d.verdict === "void") tabMoved = transitionTab(ctx, review.tab_id, ["paused"], "active");
      if (d.verdict === "freeze") tabMoved = transitionTab(ctx, review.tab_id, ["paused"], "frozen");
      stmt(
        ctx.db,
        `UPDATE reviews SET status = ?, verdict = ?, fault = ?, confidence = ?, reason = ?, voided_voucher_ids = ?,
                transcript = COALESCE(?, transcript), model = COALESCE(?, model), decided_by = ?, finished_at = ?
          WHERE id = ?`,
      ).run(
        d.failed ? "failed" : "done",
        d.verdict,
        d.fault,
        d.confidence,
        d.reason.slice(0, 500),
        JSON.stringify(voided.map((v) => v.id)),
        d.transcript ? JSON.stringify(d.transcript) : null,
        d.model,
        d.decidedBy,
        ctx.clock.now(),
        review.id,
      );
      if (review.alarm_id) {
        stmt(ctx.db, "UPDATE alarms SET status = ? WHERE id = ?").run(d.verdict === "escalate" ? "open" : "resolved", review.alarm_id);
      }
      if (d.verdict === "escalate" && d.voidVoucherIds.length > 0) kvSet(ctx.db, suggestionKey(review.id), JSON.stringify(d.voidVoucherIds));
      else kvDelete(ctx.db, suggestionKey(review.id));
    });
    for (const voucher of voided) ctx.bus.emit("voucher.voided", voucher);
    const dto = reviewDTO(reviewRow(review.id) as ReviewRow);
    ctx.bus.emit("review.finished", dto);
    if (tabMoved) announceTab(ctx, review.tab_id);
    return dto;
  }

  async function run(tabId: string, alarmId: string, reviewId: string, controller: AbortController): Promise<void> {
    const transcript: ReviewMessageDTO[] = [];
    const onMessage = (message: ReviewMessageDTO) => {
      if (closed || controller.signal.aborted) return;
      const m: ReviewMessageDTO = { role: message.role, content: String(message.content ?? "").slice(0, MAX_MESSAGE_CHARS), at: ctx.clock.now() };
      transcript.push(m);
      stmt(ctx.db, "UPDATE reviews SET transcript = ? WHERE id = ? AND status = 'running'").run(JSON.stringify(transcript), reviewId);
      ctx.bus.emit("review.message", { reviewId, tabId, message: m });
    };

    let result: SpendReviewResult | null = null;
    let failure: string | null = null;
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    try {
      const input = evidence(tabId, alarmId, reviewId);
      result = await new Promise<SpendReviewResult>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(String(controller.signal.reason))), { once: true });
        ctx.ai.reviewSpend(input, onMessage, controller.signal).then(resolve, reject);
      });
    } catch (err) {
      failure =
        controller.signal.reason === "timeout"
          ? `No verdict within ${Math.round(timeoutMs / 1000)} s: a human needs to decide.`
          : `The AI review failed (${(err as Error).message}): a human needs to decide.`;
    } finally {
      clearTimeout(timer);
    }
    if (closed || controller.signal.reason === "human" || controller.signal.reason === "shutdown") return;
    const review = reviewRow(reviewId);
    if (!review || review.status !== "running") return;

    const parsed = result ? aiResultSchema.safeParse(result) : null;
    if (!parsed?.success) {
      apply(review, {
        verdict: "escalate",
        fault: null,
        confidence: null,
        reason: failure ?? "The AI returned an unusable verdict: a human needs to decide.",
        voidVoucherIds: [],
        model: ctx.ai.llm.model,
        decidedBy: "ai",
        failed: true,
        transcript,
      });
      return;
    }
    const r = parsed.data;
    const verdict: ReviewVerdict = r.verdict !== "escalate" && r.confidence < MIN_CONFIDENCE ? "escalate" : r.verdict;
    apply(review, {
      verdict,
      fault: r.fault,
      confidence: r.confidence,
      reason: r.reason || (verdict === "escalate" ? "Not confident enough: a human needs to decide." : `Verdict: ${verdict}.`),
      voidVoucherIds: r.voidVoucherIds,
      model: r.model || ctx.ai.llm.model,
      decidedBy: "ai",
      failed: false,
      // The streamed transcript is what clients saw; fall back to the returned one if nothing streamed.
      transcript: transcript.length > 0 ? transcript : r.transcript.map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS), at: ctx.clock.now() })),
    });
  }

  const runner: ReviewRunner = {
    start(tabId, alarmId) {
      if (closed || running.has(tabId)) return null;
      if (stmt(ctx.db, "SELECT 1 FROM reviews WHERE tab_id = ? AND status = 'running' LIMIT 1").get(tabId)) return null;
      const reviewId = newId("rev");
      tx(ctx.db, () => {
        stmt(ctx.db, "INSERT INTO reviews (id, tab_id, alarm_id, status, created_at) VALUES (?, ?, ?, 'running', ?)").run(
          reviewId,
          tabId,
          alarmId,
          ctx.clock.now(),
        );
        stmt(ctx.db, "UPDATE alarms SET status = 'reviewing' WHERE id = ?").run(alarmId);
      });
      const dto = reviewDTO(reviewRow(reviewId) as ReviewRow);
      ctx.bus.emit("review.started", dto);
      const controller = new AbortController();
      const promise = run(tabId, alarmId, reviewId, controller)
        .catch((err) => ctx.log.error({ err, reviewId }, "review runner failed"))
        .finally(() => {
          if (running.get(tabId)?.reviewId === reviewId) running.delete(tabId);
        });
      running.set(tabId, { reviewId, controller, promise });
      return dto;
    },

    isRunning: (tabId) => running.has(tabId),
    isRunningAny: () => running.size > 0,

    decide(reviewId, body) {
      const input = reviewDecisionSchema.parse(body ?? {});
      const review = reviewRow(reviewId);
      if (!review) throw notFound("Review", reviewId);
      if (review.status !== "running" && review.verdict !== "escalate") {
        throw conflict("review_decided", `This review already ended with "${review.verdict}".`);
      }
      const tab = getTabRow(ctx, review.tab_id);
      if (!tab || tab.status !== "paused") {
        throw conflict("tab_not_paused", `The tab is ${tab?.status ?? "gone"}; only a paused tab's review can be decided.`);
      }
      const ids = input.voidVoucherIds ?? parseJson<string[]>(kvGet(ctx.db, suggestionKey(reviewId)), []);
      if (input.verdict === "void" && ids.length === 0) throw badRequest("Name the vouchers to void in voidVoucherIds.");
      const active = running.get(review.tab_id);
      if (active?.reviewId === reviewId) {
        active.controller.abort("human");
        running.delete(review.tab_id);
      }
      return apply(review, {
        verdict: input.verdict,
        fault: HUMAN_FAULT[input.verdict],
        confidence: review.confidence,
        reason: input.reason ?? HUMAN_REASON[input.verdict],
        voidVoucherIds: ids,
        model: null,
        decidedBy: "human",
        failed: false,
      });
    },

    humanAction(tabId, verdict) {
      const tab = getTabRow(ctx, tabId);
      if (!tab) throw notFound("Tab", tabId);
      const target = verdict === "resume" ? "active" : "frozen";
      if (tab.status === target) return getTabDTO(ctx.db, tabId, ctx.clock.now()) as TabDTO;
      const awaiting = stmt(
        ctx.db,
        "SELECT * FROM reviews WHERE tab_id = ? AND (status = 'running' OR verdict = 'escalate') ORDER BY created_at DESC LIMIT 1",
      ).get(tabId) as ReviewRow | undefined;
      if (tab.status === "paused" && awaiting) {
        runner.decide(awaiting.id, { verdict, reason: verdict === "resume" ? "Resumed by a human from the console." : "Frozen by a human from the console." });
        return getTabDTO(ctx.db, tabId, ctx.clock.now()) as TabDTO;
      }
      const from = verdict === "resume" ? (["paused", "frozen"] as const) : (["active", "paused"] as const);
      const moved = tx(ctx.db, () => {
        const ok = transitionTab(ctx, tabId, [...from], target);
        if (ok) resolveTabAlarms(ctx, tabId, { exceptKinds: ["budget_threshold"] });
        return ok;
      });
      if (!moved) {
        throw conflict("invalid_transition", `A ${tab.status.replace("_", " ")} tab can't be ${verdict === "resume" ? "resumed" : "frozen"}.`);
      }
      return announceTab(ctx, tabId) as TabDTO;
    },

    retryAfterSec: (tabId) => (running.has(tabId) ? 5 : 30),

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()].map((r) => r.promise));
    },

    shutdown() {
      if (closed) return;
      closed = true;
      for (const [tabId, r] of running) {
        r.controller.abort("shutdown");
        try {
          stmt(
            ctx.db,
            `UPDATE reviews SET status = 'failed', verdict = 'escalate', reason = 'The gateway stopped during the review: a human needs to decide.',
                    decided_by = 'ai', finished_at = ? WHERE id = ? AND status = 'running'`,
          ).run(ctx.clock.now(), r.reviewId);
        } catch (err) {
          ctx.log.warn({ err, tabId }, "could not escalate a review on shutdown");
        }
      }
      running.clear();
    },
  };
  return runner;
}

/** Reviews left running by a crash: escalate them so a human can decide. Called once at startup. */
export function recoverInterruptedReviews(ctx: AppContext): number {
  return stmt(
    ctx.db,
    `UPDATE reviews SET status = 'failed', verdict = 'escalate', reason = 'The gateway restarted during the review: a human needs to decide.',
            decided_by = 'ai', finished_at = ? WHERE status = 'running'`,
  ).run(ctx.clock.now()).changes;
}
