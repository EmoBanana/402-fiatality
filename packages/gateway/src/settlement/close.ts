/**
 * Closing a tab (SPEC §6.4): one PayPal capture for everything billable.
 *
 * 1. Stop new spending (status closing) and wait briefly for calls still in flight.
 * 2. One transaction claims the unsettled accepted vouchers (settlement_id) and records a pending
 *    settlement with the floored charge and the sub-cent carry-out.
 * 3. Outside any transaction: capture the charge with final_capture (or void the hold when the charge
 *    is $0), read the real fee from seller_receivable_breakdown and void whatever is still held.
 * 4. One transaction writes the lines (pro-rata fee split), credits seller balances, settles the tab
 *    and parks the carry-out for the company's next tab. On failure the vouchers are released and the
 *    tab is marked failed so the close can be retried.
 *
 * Idempotent: a settled tab returns its settlement; a tab left in `closing` by a crash resumes its
 * pending settlement with the same PayPal-Request-Id.
 */
import { newId, type SettlementDTO } from "@p402/shared";
import { AppError, type CloseReason } from "../context";
import { type Db, stmt, tx } from "../db/db";
import { getSettlementDTO, type SellerRow, type SettlementRow, type TabRow, voidRulesOf } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import { queueInvoice } from "./invoices";
import { allocateLines, estimatedFeeCents, noteToPayer, planSettlement } from "./math";
import {
  addCarry,
  currentAuthorizationId,
  emitSellers,
  emitTab,
  errorFields,
  inFlightVoucherCount,
  requireTab,
  settlementGross,
  type SettlementContext,
  sleep,
  unsettledGross,
  voidStats,
  withLock,
} from "./store";

/** How long past the slowest in-flight seller's own timeout a close waits for its calls to be judged. */
const IN_FLIGHT_GRACE_MS = 1_000;

export function latestSettlement(ctx: Pick<SettlementContext, "db">, tabId: string, status?: SettlementRow["status"]): SettlementRow | null {
  const sql = status
    ? "SELECT * FROM settlements WHERE tab_id = ? AND status = ? ORDER BY created_at DESC, rowid DESC LIMIT 1"
    : "SELECT * FROM settlements WHERE tab_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1";
  const params = status ? [tabId, status] : [tabId];
  return (stmt(ctx.db, sql).get(...params) as SettlementRow | undefined) ?? null;
}

export async function closeTab(ctx: SettlementContext, tabId: string, reason: CloseReason): Promise<SettlementDTO> {
  return withLock(ctx.db, `tab:${tabId}`, () => closeLocked(ctx, tabId, reason));
}

async function closeLocked(ctx: SettlementContext, tabId: string, reason: CloseReason): Promise<SettlementDTO> {
  const { db } = ctx;
  const tab = requireTab(db, tabId);
  if (tab.status === "settled") {
    const done = latestSettlement(ctx, tabId, "completed");
    if (done) return dtoOf(ctx, done.id);
    throw new AppError(409, "tab_settled", "This tab is settled but its settlement record is missing.");
  }
  if (tab.status === "pending_approval") {
    throw new AppError(409, "tab_not_authorized", "PayPal has not authorized this tab's hold yet, so there is nothing to charge.");
  }
  if (tab.status === "cancelled") throw new AppError(409, "tab_cancelled", "This tab was cancelled before PayPal authorized it.");

  let settlement = tab.status === "closing" ? latestSettlement(ctx, tabId, "pending") : null;
  if (!settlement) {
    if (tab.status !== "closing") {
      stmt(db, "UPDATE tabs SET status = 'closing' WHERE id = ?").run(tabId);
      emitTab(ctx, tabId);
    }
    await waitForInFlight(ctx, tabId);
    settlement = tx(db, () => openSettlement(ctx, requireTab(db, tabId)));
  }
  ctx.log.info(
    { tabId, settlementId: settlement.id, reason, chargedCents: settlement.charged_cents, carryOutMicros: settlement.carry_out_micros },
    "closing tab",
  );

  let outcome: { captureId: string | null; feeCents: number };
  try {
    outcome = await chargeOrRelease(ctx, requireTab(db, tabId), settlement);
  } catch (err) {
    failSettlement(ctx, tabId, settlement.id, err);
    throw err;
  }
  const completed = completeSettlement(ctx, requireTab(db, tabId), settlement, outcome);
  if (completed.chargedCents > 0) queueInvoice(ctx, completed.id);
  return completed;
}

/** The paywall aborts every forwarded call after its seller's `timeoutMs`, so this is how long the tab's calls in flight can last. */
function longestInFlightTimeoutMs(db: Db, tabId: string): number {
  const sellers = stmt(
    db,
    "SELECT DISTINCT s.void_rules FROM vouchers v JOIN sellers s ON s.id = v.seller_id WHERE v.tab_id = ? AND v.status = 'pending'",
  ).all(tabId) as Array<Pick<SellerRow, "void_rules">>;
  return Math.max(0, ...sellers.map((s) => voidRulesOf(s).timeoutMs));
}

async function waitForInFlight(ctx: SettlementContext, tabId: string): Promise<void> {
  const deadline = Date.now() + longestInFlightTimeoutMs(ctx.db, tabId) + IN_FLIGHT_GRACE_MS;
  while (inFlightVoucherCount(ctx.db, tabId) > 0) {
    if (Date.now() >= deadline) {
      ctx.log.warn({ tabId }, "closing with calls still in flight; they are voided");
      return;
    }
    await sleep(100);
  }
}

/** Inside a transaction: claim the vouchers and record what will be charged. */
function openSettlement(ctx: SettlementContext, tab: TabRow): SettlementRow {
  const { db } = ctx;
  // A call still unjudged can't join this charge, and a verdict arriving after it must not make it billable.
  stmt(
    db,
    `UPDATE vouchers SET status = 'voided', void_reason = 'timeout', response_excerpt = '[gateway] the tab closed before the seller answered'
      WHERE tab_id = ? AND status = 'pending'`,
  ).run(tab.id);
  const plan = planSettlement(unsettledGross(db, tab.id), tab.carry_in_micros);
  const voids = voidStats(db, tab.id);
  const row: SettlementRow = {
    id: newId("stl"),
    tab_id: tab.id,
    status: "pending",
    billable_micros: plan.billableMicros,
    charged_cents: plan.chargedCents,
    carry_out_micros: plan.carryOutMicros,
    paypal_fee_cents: 0,
    capture_id: null,
    naive_fee_cents: plan.naiveFeeCents,
    call_count: plan.callCount,
    void_count: voids.count,
    voided_micros: voids.micros,
    created_at: ctx.clock.now(),
    error: null,
  };
  stmt(
    db,
    `INSERT INTO settlements (id, tab_id, status, billable_micros, charged_cents, carry_out_micros, paypal_fee_cents,
                              capture_id, naive_fee_cents, call_count, void_count, voided_micros, created_at, error)
     VALUES (@id, @tab_id, @status, @billable_micros, @charged_cents, @carry_out_micros, @paypal_fee_cents,
             @capture_id, @naive_fee_cents, @call_count, @void_count, @voided_micros, @created_at, @error)`,
  ).run(row);
  stmt(db, "UPDATE vouchers SET settlement_id = ? WHERE tab_id = ? AND status = 'accepted' AND settlement_id IS NULL").run(row.id, tab.id);
  stmt(db, "UPDATE tabs SET status = 'closing' WHERE id = ?").run(tab.id);
  return row;
}

async function chargeOrRelease(
  ctx: SettlementContext,
  tab: TabRow,
  settlement: SettlementRow,
): Promise<{ captureId: string | null; feeCents: number }> {
  const authorizationId = currentAuthorizationId(tab);
  if (settlement.charged_cents === 0) {
    if (authorizationId) await releaseHold(ctx, authorizationId, `void-${settlement.id}`);
    return { captureId: null, feeCents: 0 };
  }
  if (!authorizationId) throw new AppError(409, "no_authorization", "This tab has no PayPal authorization to capture.");

  const sellers = settlementGross(ctx.db, settlement.id);
  const capture = await ctx.paypal.captureAuthorization(authorizationId, {
    amountCents: settlement.charged_cents,
    finalCapture: true,
    invoiceId: settlement.id,
    noteToPayer: noteToPayer(settlement.call_count, sellers.length),
    requestId: `capture-${settlement.id}`,
  });
  if (capture.status === "DECLINED" || capture.status === "FAILED") {
    throw new PaypalError({ operation: "capture authorization", paypalName: capture.status, message: `PayPal returned the capture as ${capture.status}` });
  }
  let feeCents = capture.feeCents;
  if (feeCents == null) {
    feeCents = estimatedFeeCents(settlement.charged_cents);
    ctx.log.warn({ tabId: tab.id, captureId: capture.id, feeCents }, "PayPal reported no fee; using the published rate");
  }
  await releaseRemainder(ctx, authorizationId, settlement.id);
  return { captureId: capture.id, feeCents };
}

/** $0 charge: void the hold. An authorization that is already voided, captured or expired holds nothing. */
async function releaseHold(ctx: SettlementContext, authorizationId: string, requestId: string): Promise<void> {
  try {
    await ctx.paypal.voidAuthorization(authorizationId, requestId);
  } catch (err) {
    if (err instanceof PaypalError && (err.httpStatus === 404 || err.httpStatus === 422)) {
      ctx.log.info({ authorizationId, ...err.toLog() }, "hold already released");
      return;
    }
    throw err;
  }
}

/** final_capture releases the rest of the hold; if PayPal still shows it as open, void it. Never fails the close. */
async function releaseRemainder(ctx: SettlementContext, authorizationId: string, settlementId: string): Promise<void> {
  try {
    const auth = await ctx.paypal.getAuthorization(authorizationId);
    if (auth.status === "CREATED" || auth.status === "PARTIALLY_CAPTURED") {
      await ctx.paypal.voidAuthorization(authorizationId, `void-rest-${settlementId}`);
      ctx.log.info({ authorizationId }, "voided the uncaptured rest of the hold");
    }
  } catch (err) {
    ctx.log.info({ authorizationId, ...errorFields(err) }, "rest of the hold not voided (final capture released it, or PayPal refused)");
  }
}

function completeSettlement(
  ctx: SettlementContext,
  tab: TabRow,
  settlement: SettlementRow,
  outcome: { captureId: string | null; feeCents: number },
): SettlementDTO {
  const { db } = ctx;
  const lines = allocateLines(settlementGross(db, settlement.id), settlement.charged_cents, outcome.feeCents);
  const now = ctx.clock.now();
  tx(db, () => {
    const insertLine = stmt(
      db,
      `INSERT INTO settlement_lines (settlement_id, seller_id, gross_micros, fee_share_micros, net_micros, calls)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(settlement_id, seller_id) DO UPDATE SET gross_micros = excluded.gross_micros,
         fee_share_micros = excluded.fee_share_micros, net_micros = excluded.net_micros, calls = excluded.calls`,
    );
    const credit = stmt(
      db,
      `INSERT INTO seller_balances (seller_id, available_micros, paid_out_micros, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(seller_id) DO UPDATE SET available_micros = available_micros + excluded.available_micros,
         updated_at = excluded.updated_at`,
    );
    for (const line of lines) {
      insertLine.run(settlement.id, line.sellerId, line.grossMicros, line.feeShareMicros, line.netMicros, line.calls);
      credit.run(line.sellerId, line.netMicros, now);
    }
    stmt(db, "UPDATE settlements SET status = 'completed', paypal_fee_cents = ?, capture_id = ?, error = NULL WHERE id = ?").run(
      outcome.feeCents,
      outcome.captureId,
      settlement.id,
    );
    stmt(db, "UPDATE tabs SET status = 'settled', closed_at = ? WHERE id = ?").run(now, tab.id);
    addCarry(db, tab.company_id, settlement.carry_out_micros);
  });

  const dto = dtoOf(ctx, settlement.id);
  ctx.bus.emit("settlement.completed", dto);
  emitTab(ctx, tab.id);
  emitSellers(ctx, lines.map((l) => l.sellerId));
  ctx.log.info(
    { tabId: tab.id, settlementId: settlement.id, captureId: outcome.captureId, chargedCents: dto.chargedCents, feeCents: dto.paypalFeeCents },
    "tab settled",
  );
  return dto;
}

function failSettlement(ctx: SettlementContext, tabId: string, settlementId: string, err: unknown): void {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  tx(ctx.db, () => {
    stmt(ctx.db, "UPDATE settlements SET status = 'failed', error = ? WHERE id = ?").run(message, settlementId);
    stmt(ctx.db, "UPDATE vouchers SET settlement_id = NULL WHERE settlement_id = ?").run(settlementId);
    stmt(ctx.db, "UPDATE tabs SET status = 'failed' WHERE id = ?").run(tabId);
  });
  emitTab(ctx, tabId);
  ctx.log.error({ tabId, settlementId, ...errorFields(err) }, "tab settlement failed");
}

function dtoOf(ctx: SettlementContext, settlementId: string): SettlementDTO {
  const dto = getSettlementDTO(ctx.db, settlementId);
  if (!dto) throw new AppError(500, "internal_error", `Settlement ${settlementId} could not be read back.`);
  return dto;
}
