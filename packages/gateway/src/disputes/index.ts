/**
 * PayPal disputes on tab charges: sync from the Disputes API, the AI dispute jury, the seller's responses
 * (evidence, offer, accepting the claim), the sandbox/mock "settle" for demos, and the mock buyer opening one.
 *
 * The service is created once per context (`disputesOf(ctx)`), so the routes, the settlement scheduler and
 * startup recovery share one jury runner. Sync runs on the scheduler (every 2 minutes in sandbox, every tick in
 * mock mode, where the demo clock ages disputes) and on demand.
 */
import {
  type DisputeActionDTO,
  type DisputeActionRequestDTO,
  type DisputeAdjudicateDTO,
  type DisputeDTO,
  type DisputeJuryDTO,
  type DisputeSyncRequestDTO,
  type DisputeSyncResultDTO,
  type MockDisputeCreateDTO,
  type ReviewMessageDTO,
} from "@p402/shared";
import { AppError, type AppContext, type DisputeReviewResult, type PaypalDispute } from "../context";
import { kvGet, kvSet, parseJson, stmt } from "../db/db";
import { getDisputeDTO, getDisputeRow, listDisputeDTOs, type DisputeRow, type SettlementRow } from "../db/dto";
import { badRequest, conflict, notFound } from "../http/errors";
import { PaypalError } from "../paypal/errors";
import { openMockDispute } from "../paypal/mock";
import { onSettlementTick } from "../settlement";
import { errorFields, withLock } from "../settlement/store";
import { chargeFacts, composeEvidence, PAYPAL_NOTE_MAX } from "./ledger";
import { announce, emitDispute, recordAction, saveJury, upsertDispute } from "./store";

export { BUYER_FAVOUR_OUTCOMES, applyRefund, moneyBackCents, upsertDispute } from "./store";
export { chargeFacts, composeEvidence, ledgerSummary, repeatedCalls, verifySignatures } from "./ledger";

/** Sandbox: poll PayPal for dispute changes this often. */
export const DISPUTE_SYNC_INTERVAL_MS = 2 * 60_000;
/** Re-read a little before the cursor so updates that land while a sync runs are not missed. */
const CURSOR_OVERLAP_MS = 10 * 60_000;
/** PayPal accepts update_time_after only within the last 180 days. */
const MAX_LOOKBACK_MS = 179 * 24 * 60 * 60_000;
const CURSOR_KEY = "disputes:cursor";
/** Past the AI's own budget, so its failure message (with transcript) lands first. */
const JURY_GRACE_MS = 5_000;
const MAX_MESSAGE_CHARS = 4_000;

export interface DisputeService {
  list(filter?: { tabId?: string; limit?: number }): DisputeDTO[];
  get(disputeId: string): DisputeDTO;
  /**
   * Poll PayPal now: disputes updated since the cursor, each fetched in full, linked and upserted. With a
   * `disputeId`, read just that case (PayPal's search can miss a new sandbox case for a while).
   */
  sync(request?: DisputeSyncRequestDTO): Promise<DisputeSyncResultDTO>;
  /** Fetch one dispute from PayPal and upsert it. */
  refresh(disputeId: string): Promise<DisputeDTO>;
  /** (Re)start the jury. Returns the dispute with the jury running. */
  startJury(disputeId: string): DisputeDTO;
  act(disputeId: string, request: DisputeActionRequestDTO): Promise<DisputeDTO>;
  /** Demo only: settle in the buyer's or seller's favour (PayPal sandbox's adjudicate, or the mock). */
  adjudicate(disputeId: string, request: DisputeAdjudicateDTO): Promise<DisputeDTO>;
  /** Mock mode only: the buyer opens a dispute on a settled tab's charge. */
  openMock(request: MockDisputeCreateDTO): Promise<DisputeDTO>;
  /** Scheduler step: sync when due. Never throws. */
  tick(): Promise<void>;
  isJuryRunning(disputeId: string): boolean;
  /** Resolves once no jury is running (tests, shutdown). */
  idle(): Promise<void>;
  /** Abort running juries (they are marked failed); later callbacks are ignored. */
  shutdown(): void;
}

const services = new WeakMap<AppContext, DisputeService>();

/** The context's dispute service, created on first use and synced after every scheduler tick from then on. */
export function disputesOf(ctx: AppContext): DisputeService {
  let service = services.get(ctx);
  if (!service) {
    const created = createDisputeService(ctx);
    services.set(ctx, (service = created));
    onSettlementTick(ctx, () => created.tick());
  }
  return service;
}

/** Juries left running by a crash: mark them failed so a human can re-run them. Called once at startup. */
export function recoverInterruptedJuries(ctx: Pick<AppContext, "db" | "clock">): number {
  const rows = stmt(ctx.db, "SELECT id, jury FROM disputes WHERE jury IS NOT NULL").all() as Array<{ id: string; jury: string }>;
  let recovered = 0;
  for (const row of rows) {
    const jury = parseJson<DisputeJuryDTO | null>(row.jury, null);
    if (jury?.status !== "running") continue;
    saveJury(ctx, row.id, { ...jury, status: "failed", reason: "The gateway restarted during the hearing: run the jury again.", finishedAt: ctx.clock.now() });
    recovered++;
  }
  return recovered;
}

const ACTION_NOTES = {
  send_evidence: "Evidence sent to PayPal.",
  make_offer: "Refund offered through PayPal.",
  accept_claim: "Claim accepted: PayPal refunds the buyer.",
} as const;

interface Running {
  controller: AbortController;
  promise: Promise<void>;
}

export function createDisputeService(ctx: AppContext): DisputeService {
  const { db } = ctx;
  const running = new Map<string, Running>();
  let closed = false;
  let lastSyncReal = 0;

  const realNow = () => ctx.clock.now() - ctx.clock.offsetMs();

  function requireRow(disputeId: string): DisputeRow {
    const row = getDisputeRow(db, disputeId);
    if (!row) throw notFound("Dispute", disputeId);
    return row;
  }

  function dto(disputeId: string): DisputeDTO {
    const found = getDisputeDTO(db, disputeId);
    if (!found) throw notFound("Dispute", disputeId);
    return found;
  }

  /** Upsert what PayPal said, announce it, and hear a new linked dispute. */
  function apply(d: PaypalDispute): { created: boolean; changed: boolean } {
    const result = upsertDispute(ctx, d);
    announce(ctx, result);
    if (result.created) {
      ctx.log.info({ disputeId: d.id, settlementId: result.row.settlement_id, reason: d.reason, amountCents: d.amountCents }, "PayPal dispute opened");
      // Disputes that arrive already resolved (history on a first sync) need no hearing.
      if (result.row.settlement_id && result.row.status !== "RESOLVED") {
        try {
          service.startJury(d.id);
        } catch (err) {
          ctx.log.warn({ disputeId: d.id, ...errorFields(err) }, "dispute jury could not start");
        }
      }
    }
    return { created: result.created, changed: result.changed };
  }

  async function refresh(disputeId: string): Promise<DisputeDTO> {
    apply(await ctx.paypal.getDispute(disputeId));
    return dto(disputeId);
  }

  /** After an action, PayPal's view decides the status; a failed refresh is logged, not thrown. */
  async function refreshQuietly(disputeId: string): Promise<void> {
    try {
      await refresh(disputeId);
    } catch (err) {
      ctx.log.warn({ disputeId, ...errorFields(err) }, "dispute refresh after an action failed; the next sync retries");
    }
  }

  function record(disputeId: string, action: Omit<DisputeActionDTO, "at">): void {
    recordAction(ctx, disputeId, { ...action, at: ctx.clock.now() });
    emitDispute(ctx, disputeId);
  }

  /** Run one PayPal call for an action and record it either way; a PayPal failure is rethrown (502). */
  async function attempt(disputeId: string, base: Omit<DisputeActionDTO, "at" | "ok" | "error">, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (err) {
      record(disputeId, { ...base, ok: false, error: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
      throw err;
    }
    record(disputeId, { ...base, ok: true, error: null });
  }

  function juryOf(row: DisputeRow): DisputeJuryDTO | null {
    return parseJson<DisputeJuryDTO | null>(row.jury, null);
  }

  async function hear(disputeId: string, jury: DisputeJuryDTO, controller: AbortController): Promise<void> {
    const row = requireRow(disputeId);
    const facts = chargeFacts(ctx, row);
    if (!facts) throw new Error("the disputed charge is not in the ledger");
    const transcript: ReviewMessageDTO[] = [];
    const onMessage = (message: ReviewMessageDTO) => {
      if (closed || controller.signal.aborted) return;
      const m: ReviewMessageDTO = { role: message.role, content: String(message.content ?? "").slice(0, MAX_MESSAGE_CHARS), at: ctx.clock.now() };
      transcript.push(m);
      saveJury(ctx, disputeId, { ...jury, transcript: [...transcript] });
      ctx.bus.emit("dispute.message", { disputeId, message: m });
    };
    const timeoutMs = ctx.config.reviewBudgetMs + JURY_GRACE_MS;
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    let result: DisputeReviewResult | null = null;
    let failure: string | null = null;
    try {
      result = await new Promise<DisputeReviewResult>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error(String(controller.signal.reason))), { once: true });
        ctx.ai.reviewDispute(facts.input, onMessage, controller.signal).then(resolve, reject);
      });
    } catch (err) {
      failure =
        controller.signal.reason === "timeout"
          ? `No recommendation within ${Math.round(timeoutMs / 1000)} s: run the jury again or decide yourself.`
          : `The jury failed (${(err as Error).message}).`;
    } finally {
      clearTimeout(timer);
    }
    if (closed || controller.signal.reason === "restart" || controller.signal.reason === "shutdown") return;
    const finishedAt = ctx.clock.now();
    const heard = transcript.length > 0 ? transcript : (result?.transcript ?? []).map((m) => ({ ...m, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
    const done: DisputeJuryDTO = result
      ? {
          ...jury,
          status: result.failed ? "failed" : "done",
          recommendation: result.recommendation,
          refundCents: result.refundCents,
          confidence: result.confidence,
          reason: result.failed && result.error ? `${result.error} Suggested by the ledger rules: ${result.reason}` : result.reason,
          draft: result.draft,
          transcript: heard,
          model: result.model || ctx.ai.llm.model,
          finishedAt,
        }
      : { ...jury, status: "failed", reason: failure ?? "The jury failed.", transcript: heard, finishedAt };
    saveJury(ctx, disputeId, done);
    emitDispute(ctx, disputeId);
    ctx.log.info({ disputeId, status: done.status, recommendation: done.recommendation ?? null, refundCents: done.refundCents ?? null }, "dispute jury finished");
  }

  const service: DisputeService = {
    list: (filter = {}) => listDisputeDTOs(db, filter),
    get: (disputeId) => dto(disputeId),

    sync(request = {}) {
      return withLock(db, "disputes:sync", async () => {
        if (request.disputeId) {
          const result = apply(await ctx.paypal.getDispute(request.disputeId));
          return { checked: 1, created: result.created ? 1 : 0, updated: !result.created && result.changed ? 1 : 0 };
        }
        const mock = ctx.paypal.mode === "mock";
        const cursor = Number(kvGet(db, CURSOR_KEY) ?? 0) || 0;
        const since = !mock && cursor > 0 ? Math.max(cursor - CURSOR_OVERLAP_MS, realNow() - MAX_LOOKBACK_MS) : null;
        const summaries = await ctx.paypal.listDisputes({ updatedAfter: since });
        let created = 0;
        let updated = 0;
        let newest = cursor;
        for (const summary of summaries) {
          const known = getDisputeRow(db, summary.id);
          if (known && summary.updatedAt != null && known.paypal_updated_at === summary.updatedAt && known.status === summary.status) continue;
          try {
            const result = apply(await ctx.paypal.getDispute(summary.id));
            if (result.created) created++;
            else if (result.changed) updated++;
            newest = Math.max(newest, summary.updatedAt ?? 0);
          } catch (err) {
            ctx.log.warn({ disputeId: summary.id, ...errorFields(err) }, "dispute details could not be read; the next sync retries");
          }
        }
        if (!mock && newest > cursor) kvSet(db, CURSOR_KEY, String(newest));
        lastSyncReal = realNow();
        return { checked: summaries.length, created, updated };
      });
    },

    refresh,

    startJury(disputeId) {
      const row = requireRow(disputeId);
      if (!row.settlement_id) {
        throw conflict("dispute_unlinked", "This dispute is not on a tab charge in the ledger, so the jury has no facts to hear.");
      }
      if (closed || running.has(disputeId)) return dto(disputeId);
      const jury: DisputeJuryDTO = {
        status: "running",
        recommendation: null,
        refundCents: null,
        confidence: null,
        reason: null,
        draft: null,
        transcript: [],
        model: ctx.ai.llm.model,
        createdAt: ctx.clock.now(),
        finishedAt: null,
      };
      saveJury(ctx, disputeId, jury);
      emitDispute(ctx, disputeId);
      const controller = new AbortController();
      const promise = hear(disputeId, jury, controller)
        .catch((err: unknown) => {
          ctx.log.error({ disputeId, ...errorFields(err) }, "dispute jury failed");
          if (!closed) {
            saveJury(ctx, disputeId, { ...jury, status: "failed", reason: `The jury could not run (${(err as Error).message}).`, finishedAt: ctx.clock.now() });
            emitDispute(ctx, disputeId);
          }
        })
        .finally(() => {
          if (running.get(disputeId)?.controller === controller) running.delete(disputeId);
        });
      running.set(disputeId, { controller, promise });
      return dto(disputeId);
    },

    async act(disputeId, request) {
      const row = requireRow(disputeId);
      if (row.status === "RESOLVED") throw conflict("dispute_resolved", "This dispute is already resolved.");
      const jury = juryOf(row);
      const allowed = parseJson<string[]>(row.paypal_actions, []);
      const note = request.note?.trim() || null;
      if (request.amountCents !== undefined && (request.amountCents < 1 || request.amountCents > row.amount_cents)) {
        throw badRequest(`amountCents must be between 1 and the disputed ${row.amount_cents} cents.`);
      }

      if (request.kind === "send_evidence") {
        const facts = chargeFacts(ctx, row);
        const fallback = "The charge is the sum of API calls the buyer's own AI agents made and signed; the per-call ledger is summarized below.";
        const text = composeEvidence(note ?? (jury?.recommendation === "contest" ? jury.draft : null) ?? fallback, facts?.input ?? null);
        const canEvidence = allowed.includes("provide_evidence") || (allowed.length === 0 && row.status === "WAITING_FOR_SELLER_RESPONSE");
        const canMessage = allowed.includes("send_message") || (allowed.length === 0 && row.stage === "INQUIRY");
        if (!canEvidence && !canMessage) {
          throw conflict("evidence_not_accepted", `PayPal is not taking the seller's evidence on this dispute now (status ${row.status}).`);
        }
        await attempt(disputeId, { kind: "send_evidence", amountCents: null, note: text }, async () => {
          if (!canEvidence) return ctx.paypal.sendDisputeMessage(disputeId, text);
          // PayPal takes only the evidence type it asked the seller for (PROOF_OF_FULFILLMENT on a not-received
          // inquiry), so read the case now; OTHER when it asked for nothing in particular.
          const requested = await ctx.paypal.getDispute(disputeId).then((d) => d.requestedEvidence.at(-1), () => undefined);
          return ctx.paypal.provideDisputeEvidence(disputeId, { notes: text, evidenceType: requested ?? "OTHER" });
        });
      } else if (request.kind === "make_offer") {
        const amount = request.amountCents ?? (jury?.refundCents && jury.refundCents > 0 ? Math.min(jury.refundCents, row.amount_cents) : null);
        if (!amount) throw badRequest("Name the refund to offer in amountCents.");
        const text = (note ?? (jury?.recommendation !== "contest" ? jury?.draft : null) ?? `We offer a refund of ${amount} cents to resolve this dispute.`).slice(0, PAYPAL_NOTE_MAX);
        await attempt(disputeId, { kind: "make_offer", amountCents: amount, note: text }, () =>
          ctx.paypal.makeDisputeOffer(disputeId, { amountCents: amount, note: text, invoiceId: `offer-${disputeId}`.slice(0, 127) }),
        );
      } else if (request.kind === "accept_claim") {
        const partial = request.amountCents !== undefined && request.amountCents < row.amount_cents ? request.amountCents : null;
        const text = (note ?? (jury?.recommendation === "accept" ? jury.draft : null) ?? "We accept the claim and refund the buyer.").slice(0, PAYPAL_NOTE_MAX);
        await attempt(disputeId, { kind: "accept_claim", amountCents: partial ?? row.amount_cents, note: text }, () =>
          ctx.paypal.acceptDisputeClaim(disputeId, { note: text, refundCents: partial }),
        );
      } else {
        throw badRequest(`Unknown action ${(request as { kind: string }).kind}.`);
      }
      ctx.log.info({ disputeId, kind: request.kind }, ACTION_NOTES[request.kind]);
      await refreshQuietly(disputeId);
      return dto(disputeId);
    },

    async adjudicate(disputeId, request) {
      if (!ctx.config.demo) throw new AppError(403, "demo_only", "Settling a dispute is a demo-only action (DEMO_MODE=1, PayPal sandbox or mock).");
      const row = requireRow(disputeId);
      if (row.status === "RESOLVED") throw conflict("dispute_resolved", "This dispute is already resolved.");
      // PayPal refuses to rule on a claim the seller accepted: it refunds the buyer and closes the case itself.
      if (parseJson<DisputeActionDTO[]>(row.actions, []).some((a) => a.kind === "accept_claim" && a.ok)) {
        throw conflict("claim_accepted", "The seller accepted this claim, so PayPal closes it in the buyer's favour on its own.");
      }
      const outcome = request.outcome === "buyer" ? "BUYER_FAVOR" : "SELLER_FAVOR";
      const words = request.outcome === "buyer" ? "the buyer's" : "the seller's";
      const mode = ctx.paypal.mode === "mock" ? "mock PayPal" : "PayPal sandbox";
      await attempt(disputeId, { kind: "sandbox_adjudicate", amountCents: null, note: `Settled in ${words} favour (${mode}).` }, async () => {
        try {
          await ctx.paypal.adjudicateDispute(disputeId, outcome);
        } catch (err) {
          // PayPal settles only disputes under review: escalate an inquiry to a claim first, then settle it.
          if (!(err instanceof PaypalError && err.httpStatus === 422 && row.stage === "INQUIRY")) throw err;
          await ctx.paypal.escalateDispute(disputeId, "Escalated to settle the 402 Fiatality sandbox demo.");
          await ctx.paypal.adjudicateDispute(disputeId, outcome);
        }
      });
      await refreshQuietly(disputeId);
      return dto(disputeId);
    },

    async openMock(request) {
      if (ctx.paypal.mode !== "mock") throw notFound("Route", "POST /api/disputes/mock");
      const settlement = stmt(db, "SELECT * FROM settlements WHERE id = ?").get(request.settlementId) as SettlementRow | undefined;
      if (!settlement) throw notFound("Settlement", request.settlementId);
      if (settlement.status !== "completed" || !settlement.capture_id || settlement.charged_cents <= 0) {
        throw conflict("not_charged", "Only a settled tab's PayPal charge can be disputed.");
      }
      if (request.amountCents !== undefined && request.amountCents > settlement.charged_cents) {
        throw badRequest(`amountCents can be at most the ${settlement.charged_cents} cents charged.`);
      }
      let opened: PaypalDispute;
      try {
        opened = openMockDispute(ctx, {
          captureId: settlement.capture_id,
          reason: request.reason,
          message: request.message,
          amountCents: request.amountCents,
        });
      } catch (err) {
        if (err instanceof PaypalError && err.httpStatus === 422) throw conflict("dispute_not_allowed", err.issues[0]?.description ?? err.message);
        throw err;
      }
      apply(await ctx.paypal.getDispute(opened.id));
      return dto(opened.id);
    },

    async tick() {
      const due = ctx.paypal.mode === "mock" || realNow() - lastSyncReal >= DISPUTE_SYNC_INTERVAL_MS;
      if (!due || closed) return;
      try {
        await service.sync();
      } catch (err) {
        lastSyncReal = realNow();
        ctx.log.warn(errorFields(err), "dispute sync failed; retrying on a later tick");
      }
    },

    isJuryRunning: (disputeId) => running.has(disputeId),

    async idle() {
      while (running.size > 0) await Promise.allSettled([...running.values()].map((r) => r.promise));
    },

    shutdown() {
      if (closed) return;
      closed = true;
      for (const [disputeId, r] of running) {
        r.controller.abort("shutdown");
        try {
          const row = getDisputeRow(db, disputeId);
          const jury = row ? juryOf(row) : null;
          if (jury?.status === "running") {
            saveJury(ctx, disputeId, { ...jury, status: "failed", reason: "The gateway stopped during the hearing: run the jury again.", finishedAt: ctx.clock.now() });
          }
        } catch (err) {
          ctx.log.warn({ disputeId, ...errorFields(err) }, "could not mark a jury failed on shutdown");
        }
      }
      running.clear();
    },
  };
  return service;
}

/** Dispute ids PayPal issues (PP-D-27803, PP-R-AYP-10135034) and the mock's MOCK-D-... */
export const DISPUTE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
