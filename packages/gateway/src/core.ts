/**
 * Per-context runtime state of the gateway core: running reviews and agent runs, plus the work that follows a
 * judged voucher (alarm detectors, threshold close), kept off the response path. buildServer creates it with
 * its options; route modules reach it with `coreOf(ctx)`.
 */
import { DEFAULT_POLICY, MICROS_PER_CENT, type Policy } from "@p402/shared";
import { createAgentRunner, MAX_CONCURRENT_RUNS, type AgentRunner } from "./agents/runs";
import { evaluateAlarms } from "./alarms/engine";
import type { AppContext } from "./context";
import { parseJson, stmt } from "./db/db";
import { createReviewRunner, type ReviewRunner } from "./review/runner";
import { getTabRow } from "./tabs/state";

export interface CoreOptions {
  /** Where in-process agents reach the gateway. Defaults to config.publicBaseUrl. */
  gatewayUrl?: string | (() => string);
  /** AI review budget before escalating (default 45 s). */
  reviewTimeoutMs?: number;
  maxConcurrentRuns?: number;
}

export interface Core {
  reviews: ReviewRunner;
  agents: AgentRunner;
  /** Schedule alarm detection (and the threshold close for accepted calls) after a voucher was judged. */
  afterVoucher(tabId: string, status: "accepted" | "voided", reqHash: string): void;
  /** Resolves when background work and reviews have settled (tests). Agent runs: `agents.idle()`. */
  idle(): Promise<void>;
  shutdown(): void;
}

/** After a failed threshold close, wait this long before trying again on the next voucher. */
const CLOSE_RETRY_MS = 30_000;
const REVIEW_GRACE_MS = 5_000;

const cores = new WeakMap<AppContext, Core>();

export function createCore(ctx: AppContext, opts: CoreOptions = {}): Core {
  const gatewayUrl = typeof opts.gatewayUrl === "function" ? opts.gatewayUrl : () => (opts.gatewayUrl as string | undefined) ?? ctx.config.publicBaseUrl;
  // A grace period past the AI's own budget, so its escalation (with transcript and reason) lands first.
  const reviews = createReviewRunner(ctx, { timeoutMs: opts.reviewTimeoutMs ?? ctx.config.reviewBudgetMs + REVIEW_GRACE_MS });
  const agents = createAgentRunner(ctx, { gatewayUrl, maxConcurrent: opts.maxConcurrentRuns ?? MAX_CONCURRENT_RUNS });
  const pending = new Set<Promise<void>>();
  const closing = new Set<string>();
  let closed = false;

  const track = (work: Promise<void>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work));
  };

  /** SPEC §5.3: an accepted call that brings billable spend to closeAtCents triggers the one PayPal charge. */
  function closeAtThreshold(tabId: string): void {
    if (closing.has(tabId)) return;
    const tab = getTabRow(ctx, tabId);
    if (!tab || (tab.status !== "active" && tab.status !== "paused")) return;
    const policy = parseJson<Policy>(tab.policy, DEFAULT_POLICY);
    const { billable } = stmt(ctx.db, "SELECT COALESCE(SUM(price_micros), 0) AS billable FROM vouchers WHERE tab_id = ? AND status = 'accepted'").get(
      tabId,
    ) as { billable: number };
    if (billable + tab.carry_in_micros < policy.closeAtCents * MICROS_PER_CENT) return;
    closing.add(tabId);
    ctx.log.info({ tabId, billable }, "tab reached its close threshold: settling");
    track(
      Promise.resolve()
        .then(() => ctx.settlement.closeTab(tabId, "threshold"))
        .then(
          () => {
            closing.delete(tabId);
          },
          (err: unknown) => {
            ctx.log.error({ err, tabId }, "threshold close failed");
            setTimeout(() => closing.delete(tabId), CLOSE_RETRY_MS).unref();
          },
        ),
    );
  }

  const core: Core = {
    reviews,
    agents,
    afterVoucher(tabId, status, reqHash) {
      if (closed) return;
      track(
        new Promise<void>((resolve) => {
          setImmediate(() => {
            try {
              if (!closed) {
                evaluateAlarms(ctx, reviews, tabId, reqHash);
                if (status === "accepted") closeAtThreshold(tabId);
              }
            } catch (err) {
              ctx.log.error({ err, tabId }, "post-voucher checks failed");
            }
            resolve();
          });
        }),
      );
    },
    async idle() {
      while (pending.size > 0 || reviews.isRunningAny()) {
        await Promise.allSettled([...pending]);
        await reviews.idle();
      }
    },
    shutdown() {
      closed = true;
      reviews.shutdown();
      agents.shutdown();
    },
  };
  cores.set(ctx, core);
  return core;
}

/** The context's core (created with defaults when buildServer did not create one, e.g. in scripts). */
export function coreOf(ctx: AppContext): Core {
  return cores.get(ctx) ?? createCore(ctx);
}
