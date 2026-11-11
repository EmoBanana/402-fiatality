/**
 * SettlementService (SPEC §6): hold -> authorize -> reauthorize -> one capture -> payouts, plus purchases,
 * statements and invoice records. Phase 2 wires it in src/services.ts as `settlement: (ctx) => createSettlementService(ctx)`.
 * After each scheduler tick it retries invoice records, then runs hooks other modules register with
 * `onSettlementTick` (the PayPal dispute sync).
 *
 * The routes in src/routes/settlement.ts also use the module functions re-exported below (PayPal return and
 * cancel, demo rescheduling), which take the same context; per-tab locks are shared through the database.
 */
import type { AppContext, SettlementService } from "../context";
import { closeTab } from "./close";
import { createHold } from "./holds";
import { retryInvoices } from "./invoices";
import { runPayouts } from "./payouts";
import { checkoutPurchase, proposePurchase } from "./purchases";
import { tickOnce } from "./scheduler";
import { statement } from "./statement";
import { errorFields } from "./store";

export { cancelApproval, completeApproval } from "./approvals";
export { latestSettlement } from "./close";
export { BRAND_NAME, hashEnrollToken, HOLD_DESCRIPTION, rescheduleTab, SOFT_DESCRIPTOR, type ApprovalKind } from "./holds";
export { allocateLines, planSettlement, type PlannedLine, type SellerGross, type SettlementPlan } from "./math";
export { DEFAULT_PAYOUT_THRESHOLD_CENTS, PAYOUT_FEE_CENTS } from "./payouts";
export { getInvoiceDTO, invoiceNumber, queueInvoice, recordInvoice, retryInvoices } from "./invoices";
export { pendingCarry, type SettlementContext } from "./store";

/** SPEC §6.3: the scheduler runs every 30 s. */
export const TICK_INTERVAL_MS = 30_000;

export function createSettlementService(ctx: AppContext): SettlementService {
  let timer: ReturnType<typeof setInterval> | null = null;
  let kickoff: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const service: SettlementService = {
    createHold: (input) => createHold(ctx, input),
    closeTab: (tabId, reason) => closeTab(ctx, tabId, reason),
    tick() {
      // Ticks never overlap: a tick requested while one runs starts right after it (the clock may have moved).
      const run = chain.then(() => tickOnce(ctx)).then(() => afterTick(ctx));
      chain = run.catch(() => undefined);
      return run;
    },
    runPayouts: (opts) => runPayouts(ctx, opts),
    proposePurchase: (input) => proposePurchase(ctx, input),
    checkoutPurchase: (purchaseId) => checkoutPurchase(ctx, purchaseId),
    statement: (tabId) => statement(ctx, tabId),
    start() {
      if (timer) return;
      const run = () => {
        service.tick().catch((err: unknown) => ctx.log.error(errorFields(err), "settlement tick failed"));
      };
      timer = setInterval(run, TICK_INTERVAL_MS);
      timer.unref();
      // Resume anything a restart interrupted (tabs left closing, pending payouts) without waiting 30 s.
      kickoff = setTimeout(run, 1_000);
      kickoff.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      if (kickoff) clearTimeout(kickoff);
      timer = null;
      kickoff = null;
    },
  };
  return service;
}

type TickHook = () => Promise<void>;
const tickHooks = new WeakMap<AppContext, Set<TickHook>>();

/**
 * Run `hook` after every scheduler tick of this context (the PayPal dispute sync registers itself here), so
 * work that ages with the demo clock also runs right after POST /api/clock/advance. Returns an unregister.
 */
export function onSettlementTick(ctx: AppContext, hook: TickHook): () => void {
  let hooks = tickHooks.get(ctx);
  if (!hooks) tickHooks.set(ctx, (hooks = new Set()));
  hooks.add(hook);
  return () => void hooks.delete(hook);
}

/** After the tab lifecycle: retry invoice records, then the registered hooks. Never throws. */
async function afterTick(ctx: AppContext): Promise<void> {
  try {
    await retryInvoices(ctx);
  } catch (err) {
    ctx.log.error(errorFields(err), "invoice retry failed");
  }
  for (const hook of tickHooks.get(ctx) ?? []) {
    try {
      await hook();
    } catch (err) {
      ctx.log.error(errorFields(err), "scheduler hook failed");
    }
  }
}
