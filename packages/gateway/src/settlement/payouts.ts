/**
 * Seller payouts (SPEC §6.5). Sellers owed at least the threshold (default $10) are paid their balance, less
 * what open PayPal disputes hold back, floored to cents minus the $0.25 Payouts API fee, in one PayPal batch whose sender_batch_id is our
 * payout id. Balances are debited before PayPal is called (so concurrent runs can't pay twice) and given
 * back for every item PayPal rejects. The mock completes at once; sandbox batches are polled briefly and
 * then refreshed by the scheduler. `payout.completed` fires when a batch reaches a final state.
 */
import { MICROS_PER_CENT, newId, PAYPAL_US_FEES, type PayoutDTO } from "@p402/shared";
import { AppError, type PaypalPayoutBatch } from "../context";
import { stmt, tx } from "../db/db";
import { payoutDTO, sellerHeldMicros, type PayoutItemRow, type PayoutRow } from "../db/dto";
import { emitSellers, errorFields, type SettlementContext, sleep, withLock } from "./store";

export const DEFAULT_PAYOUT_THRESHOLD_CENTS = 1_000;
export const PAYOUT_FEE_CENTS = PAYPAL_US_FEES.payoutApiFlatCents;
const PAYOUT_NOTE = "402 Fiatality weekly payout";
const PAYOUT_SUBJECT = "You have a payout from 402 Fiatality";
/** Item statuses where the money did not reach (and will not reach) the seller. */
const FAILED_ITEM_STATUSES = new Set(["FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED", "CANCELED", "CANCELLED"]);
const FINAL_BATCH_STATUSES = new Set(["SUCCESS", "DENIED", "CANCELED", "CANCELLED"]);
const POLL_DELAYS_MS = [1_500, 3_000];
const PAYOUTS_LOCK = "payouts";

const senderItemId = (payoutId: string, sellerId: string) => `${payoutId}:${sellerId}`;

function loadPayout(ctx: SettlementContext, id: string): PayoutRow | null {
  return (stmt(ctx.db, "SELECT * FROM payouts WHERE id = ?").get(id) as PayoutRow | undefined) ?? null;
}

function dtoOf(ctx: SettlementContext, id: string): PayoutDTO {
  const row = loadPayout(ctx, id);
  if (!row) throw new AppError(500, "internal_error", `Payout ${id} could not be read back.`);
  return payoutDTO(ctx.db, row);
}

/** SPEC §6.5. Null when no seller is owed at least the threshold (after the fee there must be a cent left). */
export async function runPayouts(ctx: SettlementContext, opts: { thresholdCents?: number } = {}): Promise<PayoutDTO | null> {
  const threshold = opts.thresholdCents ?? DEFAULT_PAYOUT_THRESHOLD_CENTS;
  if (!Number.isSafeInteger(threshold) || threshold < 1) {
    throw new AppError(400, "invalid_request", "thresholdCents must be a whole number of cents, at least 1.");
  }
  return withLock(ctx.db, PAYOUTS_LOCK, async () => {
    const created = tx(ctx.db, () => createPayout(ctx, threshold));
    if (!created) return null;
    emitSellers(ctx, created.sellerIds);
    await submitPayout(ctx, created.id);
    return dtoOf(ctx, created.id);
  });
}

/** Inside a transaction: pick the sellers, record the payout and debit their balances. */
function createPayout(ctx: SettlementContext, thresholdCents: number): { id: string; sellerIds: string[] } | null {
  const { db } = ctx;
  const owed = stmt(
    db,
    `SELECT b.seller_id, b.available_micros FROM seller_balances b JOIN sellers s ON s.id = b.seller_id
      WHERE b.available_micros >= ? ORDER BY b.seller_id`,
  ).all(thresholdCents * MICROS_PER_CENT) as Array<{ seller_id: string; available_micros: number }>;
  // Earnings under an open PayPal dispute stay until it resolves.
  const items = owed
    .map((r) => ({ sellerId: r.seller_id, payableMicros: r.available_micros - sellerHeldMicros(db, r.seller_id) }))
    .filter((r) => r.payableMicros >= thresholdCents * MICROS_PER_CENT)
    .map((r) => ({ sellerId: r.sellerId, amountCents: Math.floor(r.payableMicros / MICROS_PER_CENT) - PAYOUT_FEE_CENTS }))
    .filter((i) => i.amountCents > 0);
  if (items.length === 0) return null;

  const id = newId("po");
  const now = ctx.clock.now();
  const totalCents = items.reduce((s, i) => s + i.amountCents, 0);
  stmt(db, "INSERT INTO payouts (id, status, total_cents, fee_cents, created_at) VALUES (?, 'pending', ?, ?, ?)").run(
    id,
    totalCents,
    items.length * PAYOUT_FEE_CENTS,
    now,
  );
  const insertItem = stmt(
    db,
    "INSERT INTO payout_items (payout_id, seller_id, amount_cents, fee_cents, status) VALUES (?, ?, ?, ?, 'PENDING')",
  );
  const debit = stmt(
    db,
    `UPDATE seller_balances SET available_micros = available_micros - ?, paid_out_micros = paid_out_micros + ?, updated_at = ?
      WHERE seller_id = ?`,
  );
  for (const item of items) {
    insertItem.run(id, item.sellerId, item.amountCents, PAYOUT_FEE_CENTS);
    debit.run((item.amountCents + PAYOUT_FEE_CENTS) * MICROS_PER_CENT, item.amountCents * MICROS_PER_CENT, now, item.sellerId);
  }
  return { id, sellerIds: items.map((i) => i.sellerId) };
}

/** Send the batch (same sender_batch_id / PayPal-Request-Id on a retry), then poll briefly. */
async function submitPayout(ctx: SettlementContext, payoutId: string): Promise<void> {
  const items = stmt(
    ctx.db,
    `SELECT i.*, s.paypal_email FROM payout_items i JOIN sellers s ON s.id = i.seller_id WHERE i.payout_id = ? ORDER BY i.seller_id`,
  ).all(payoutId) as Array<PayoutItemRow & { paypal_email: string }>;

  let batch: PaypalPayoutBatch;
  try {
    batch = await ctx.paypal.createPayoutBatch({
      senderBatchId: payoutId,
      emailSubject: PAYOUT_SUBJECT,
      note: PAYOUT_NOTE,
      items: items.map((i) => ({
        senderItemId: senderItemId(payoutId, i.seller_id),
        receiverEmail: i.paypal_email,
        amountCents: i.amount_cents,
        note: PAYOUT_NOTE,
      })),
    });
  } catch (err) {
    // PayPal rejected the batch: nothing was sent, so the sellers get their balances back.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    applyBatch(ctx, payoutId, { batchId: "", status: "DENIED", items: [] }, message);
    ctx.log.error({ payoutId, ...errorFields(err) }, "payout batch rejected");
    throw err;
  }

  stmt(ctx.db, "UPDATE payouts SET paypal_batch_id = ? WHERE id = ?").run(batch.batchId, payoutId);
  if (applyBatch(ctx, payoutId, batch)) return;
  for (const delay of POLL_DELAYS_MS) {
    await sleep(delay);
    try {
      if (applyBatch(ctx, payoutId, await ctx.paypal.getPayoutBatch(batch.batchId))) return;
    } catch (err) {
      ctx.log.warn({ payoutId, ...errorFields(err) }, "payout status check failed; the scheduler will retry");
      return;
    }
  }
}

/**
 * Record PayPal's view of a batch. Items that failed get their amount and fee back. Returns true once the
 * batch is final (and emits `payout.completed`).
 */
function applyBatch(ctx: SettlementContext, payoutId: string, batch: PaypalPayoutBatch, error?: string): boolean {
  const { db } = ctx;
  const final = FINAL_BATCH_STATUSES.has(batch.status.toUpperCase());
  const denied = batch.status.toUpperCase() !== "SUCCESS" && final;
  const restored: string[] = [];
  let status: PayoutDTO["status"] = "pending";

  tx(db, () => {
    const rows = stmt(db, "SELECT * FROM payout_items WHERE payout_id = ?").all(payoutId) as PayoutItemRow[];
    const reported = new Map(batch.items.map((item) => [item.senderItemId, item]));
    const now = ctx.clock.now();
    for (const row of rows) {
      const item = reported.get(senderItemId(payoutId, row.seller_id));
      const nextStatus = denied ? (FAILED_ITEM_STATUSES.has(row.status) ? row.status : "DENIED") : (item?.status.toUpperCase() ?? row.status);
      const wasFailed = FAILED_ITEM_STATUSES.has(row.status);
      const nowFailed = FAILED_ITEM_STATUSES.has(nextStatus);
      stmt(db, "UPDATE payout_items SET status = ?, paypal_item_id = COALESCE(?, paypal_item_id) WHERE payout_id = ? AND seller_id = ?").run(
        nextStatus,
        item?.payoutItemId ?? null,
        payoutId,
        row.seller_id,
      );
      if (nowFailed && !wasFailed) {
        stmt(
          db,
          `UPDATE seller_balances SET available_micros = available_micros + ?, paid_out_micros = paid_out_micros - ?, updated_at = ?
            WHERE seller_id = ?`,
        ).run((row.amount_cents + row.fee_cents) * MICROS_PER_CENT, row.amount_cents * MICROS_PER_CENT, now, row.seller_id);
        restored.push(row.seller_id);
      }
    }
    if (final) {
      const after = stmt(db, "SELECT status FROM payout_items WHERE payout_id = ?").all(payoutId) as Array<{ status: string }>;
      const failed = after.filter((r) => FAILED_ITEM_STATUSES.has(r.status)).length;
      status = failed === 0 ? "success" : failed === after.length ? "failed" : "partial";
    }
    stmt(db, "UPDATE payouts SET status = ?, error = COALESCE(?, error) WHERE id = ?").run(status, error ?? null, payoutId);
  });

  if (restored.length > 0) emitSellers(ctx, restored);
  if (final) {
    ctx.bus.emit("payout.completed", dtoOf(ctx, payoutId));
    ctx.log.info({ payoutId, batchId: batch.batchId || null, status }, "payout finished");
  }
  return final;
}

/** Scheduler: bring pending payouts up to date; resend batches a crash left unsent (idempotent). */
export async function refreshPayouts(ctx: SettlementContext): Promise<void> {
  const pending = stmt(ctx.db, "SELECT id, paypal_batch_id FROM payouts WHERE status = 'pending' ORDER BY created_at").all() as Array<
    Pick<PayoutRow, "id" | "paypal_batch_id">
  >;
  if (pending.length === 0) return;
  await withLock(ctx.db, PAYOUTS_LOCK, async () => {
    for (const payout of pending) {
      const current = loadPayout(ctx, payout.id);
      if (!current || current.status !== "pending") continue;
      try {
        if (current.paypal_batch_id) applyBatch(ctx, current.id, await ctx.paypal.getPayoutBatch(current.paypal_batch_id));
        else await submitPayout(ctx, current.id);
      } catch (err) {
        ctx.log.warn({ payoutId: current.id, ...errorFields(err) }, "payout refresh failed");
      }
    }
  });
}
