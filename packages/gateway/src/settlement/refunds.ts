/**
 * Refunds of the agent's purchases (paypal-plan.md): all or part of a captured purchase goes back to the buyer through
 * PaymentsController.refundCapturedPayment.
 *
 * The refund row is the claim. It is written before PayPal is called and keyed by the caller's idempotency key, so the
 * same key never refunds twice; its id is the PayPal-Request-Id and the invoice_id we send. When PayPal's answer is
 * lost, the order is re-read for a refund carrying that invoice_id: found, it is settled from what PayPal holds; not
 * found, it stays unknown (never failed), and asking again with the same key re-sends the same request id.
 */
import { formatCents, newId, type PurchaseRefundRequestDTO } from "@p402/shared";
import { AppError, type PaypalRefund, type PurchaseRefundOutcome } from "../context";
import { stmt, tx } from "../db/db";
import { purchaseRefundDTO, type PurchaseRefundRow, type PurchaseRow } from "../db/dto";
import { outcomeUnknown, PaypalError, paypalReason } from "../paypal/errors";
import { emitPurchase, errorFields, loadPurchase, loadPurchaseRefunds, purchaseView, type SettlementContext, withLock } from "./store";

const OPERATION = "refund capture";

/** Refunds that count against what is left: done, in flight, or not confirmed either way. */
const HOLDING = new Set<PurchaseRefundRow["status"]>(["processing", "completed", "pending", "unknown"]);

/** The PayPal-Request-Id and invoice_id of a refund. */
const reference = (refundId: string) => `refund-${refundId}`;

/** POST /api/purchases/:id/refund. */
export async function refundPurchase(
  ctx: SettlementContext,
  purchaseId: string,
  input: PurchaseRefundRequestDTO,
): Promise<PurchaseRefundOutcome> {
  return withLock(ctx.db, `purchase:${purchaseId}`, async () => {
    const purchase = loadPurchase(ctx.db, purchaseId);
    if (!purchase) throw new AppError(404, "not_found", `Purchase ${purchaseId} was not found.`);
    const key = input.idempotencyKey ?? newId("key");

    const earlier = findRefund(ctx, purchaseId, key);
    if (earlier) return answerAgain(ctx, purchase, earlier);
    const claim = claimRefund(ctx, purchase, key, input.amountCents);
    if (!claim.fresh) return answerAgain(ctx, purchase, claim.row);
    return send(ctx, purchase, claim.row, false);
  });
}

/** A key used before. Still open: re-send its request id and let PayPal say what happened; otherwise the same answer. */
async function answerAgain(ctx: SettlementContext, purchase: PurchaseRow, refund: PurchaseRefundRow): Promise<PurchaseRefundOutcome> {
  if (refund.status === "processing" || refund.status === "unknown") return send(ctx, purchase, refund, true);
  return outcome(ctx, purchase, refund, true);
}

function findRefund(ctx: SettlementContext, purchaseId: string, key: string): PurchaseRefundRow | null {
  return (
    (stmt(ctx.db, "SELECT * FROM purchase_refunds WHERE purchase_id = ? AND idempotency_key = ?").get(purchaseId, key) as
      | PurchaseRefundRow
      | undefined) ?? null
  );
}

function loadRefund(ctx: SettlementContext, id: string): PurchaseRefundRow {
  return stmt(ctx.db, "SELECT * FROM purchase_refunds WHERE id = ?").get(id) as PurchaseRefundRow;
}

/**
 * Check what may be refunded, then write the claim, in one transaction (paypal-plan.md 1b.1, 1b.2). When the same key
 * was claimed first, the unique (purchase_id, idempotency_key) refuses this claim and the winner's row comes back.
 */
function claimRefund(
  ctx: SettlementContext,
  purchase: PurchaseRow,
  key: string,
  amountCents: number | undefined,
): { row: PurchaseRefundRow; fresh: boolean } {
  if (purchase.status !== "captured" || !purchase.capture_id || !purchase.paypal_order_id) {
    throw new AppError(409, "purchase_not_paid", "Only a paid purchase can be refunded.");
  }
  return tx(ctx.db, () => {
    const held = loadPurchaseRefunds(ctx.db, purchase.id).reduce((sum, r) => (HOLDING.has(r.status) ? sum + r.amount_cents : sum), 0);
    const left = purchase.amount_cents - held;
    if (left <= 0) throw new AppError(409, "purchase_refunded", "This purchase has already been refunded in full.");
    const amount = amountCents ?? left;
    if (amount > left) throw new AppError(409, "refund_too_large", `Only ${formatCents(left)} of this purchase is left to refund.`);

    const id = newId("rfd");
    const now = ctx.clock.now();
    try {
      stmt(
        ctx.db,
        `INSERT INTO purchase_refunds (id, purchase_id, idempotency_key, amount_cents, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
      ).run(id, purchase.id, key, amount, now, now);
    } catch (err) {
      if ((err as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        const winner = findRefund(ctx, purchase.id, key);
        if (winner) return { row: winner, fresh: false };
      }
      throw err;
    }
    return { row: loadRefund(ctx, id), fresh: true };
  });
}

/** Ask PayPal for the claimed refund and record the answer (paypal-plan.md 1b.4). */
async function send(ctx: SettlementContext, purchase: PurchaseRow, claim: PurchaseRefundRow, replay: boolean): Promise<PurchaseRefundOutcome> {
  try {
    const refund = await ctx.paypal.refundCapture(purchase.capture_id ?? "", {
      amountCents: claim.amount_cents,
      invoiceId: reference(claim.id),
      requestId: reference(claim.id),
    });
    settle(ctx, claim, refund);
  } catch (err) {
    if (outcomeUnknown(err, OPERATION)) {
      const found = await reread(ctx, purchase, claim);
      if (found) settle(ctx, claim, found);
      else mark(ctx, claim.id, "unknown", "PayPal did not confirm this refund yet. Asking again with the same key is safe.");
    } else if (err instanceof PaypalError && err.operation === OPERATION && callersFault(err.httpStatus)) {
      // PayPal refused this refund for a reason the caller can act on: keep it on record, with PayPal's reason.
      const reason = paypalReason(err);
      mark(ctx, claim.id, "rejected", reason);
      emitPurchase(ctx, purchase.id);
      throw new AppError(err.httpStatus ?? 422, "refund_rejected", reason, err.details);
    } else {
      // Our credentials or quota, or never sent: nothing was refunded. A fresh claim is released so the key can retry.
      if (replay) mark(ctx, claim.id, "unknown", "PayPal did not confirm this refund yet. Asking again with the same key is safe.");
      else stmt(ctx.db, "DELETE FROM purchase_refunds WHERE id = ?").run(claim.id);
      emitPurchase(ctx, purchase.id);
      ctx.log.warn({ purchaseId: purchase.id, refundId: claim.id, ...errorFields(err) }, "purchase refund not sent");
      throw ourFailure(err);
    }
  }
  emitPurchase(ctx, purchase.id);
  return outcome(ctx, purchase, loadRefund(ctx, claim.id), replay);
}

/** After a lost answer: the order's refunds, found by the invoice_id we sent. Null when absent or unreadable. */
async function reread(ctx: SettlementContext, purchase: PurchaseRow, claim: PurchaseRefundRow): Promise<PaypalRefund | null> {
  try {
    const order = await ctx.paypal.getOrder(purchase.paypal_order_id ?? "");
    return order.refunds?.find((r) => r.invoiceId === reference(claim.id)) ?? null;
  } catch (err) {
    ctx.log.warn({ purchaseId: purchase.id, refundId: claim.id, ...errorFields(err) }, "refund re-read failed");
    return null;
  }
}

function settle(ctx: SettlementContext, claim: PurchaseRefundRow, refund: PaypalRefund): void {
  const status = refund.status === "COMPLETED" ? "completed" : refund.status === "FAILED" || refund.status === "CANCELLED" ? "failed" : "pending";
  const amountCents = refund.amountCents && refund.amountCents > 0 ? refund.amountCents : claim.amount_cents;
  stmt(ctx.db, "UPDATE purchase_refunds SET status = ?, paypal_refund_id = ?, amount_cents = ?, error = NULL, updated_at = ? WHERE id = ?").run(
    status,
    refund.id,
    amountCents,
    ctx.clock.now(),
    claim.id,
  );
  ctx.log.info({ refundId: claim.id, paypalRefundId: refund.id, status: refund.status, amountCents }, "purchase refund recorded");
}

function mark(ctx: SettlementContext, id: string, status: PurchaseRefundRow["status"], error: string): void {
  stmt(ctx.db, "UPDATE purchase_refunds SET status = ?, error = ?, updated_at = ? WHERE id = ?").run(status, error, ctx.clock.now(), id);
}

/** A 4xx the caller can act on; our credentials (401/403) and quota (429) are not theirs. */
function callersFault(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 401 && status !== 403 && status !== 429;
}

function ourFailure(err: unknown): unknown {
  if (!(err instanceof PaypalError)) return err;
  if (err.httpStatus === 429) return new AppError(503, "paypal_busy", "PayPal is rate limiting us. Nothing was refunded; try again in a minute.");
  if (err.httpStatus === 401 || err.httpStatus === 403) {
    return new AppError(502, "paypal_unavailable", "PayPal refused our credentials. Nothing was refunded.");
  }
  return new AppError(502, "paypal_unavailable", "PayPal could not be reached. Nothing was refunded.");
}

function outcome(ctx: SettlementContext, purchase: PurchaseRow, refund: PurchaseRefundRow, replay: boolean): PurchaseRefundOutcome {
  const row = loadPurchase(ctx.db, purchase.id) ?? purchase;
  return { result: { purchase: purchaseView(ctx.db, row), refund: purchaseRefundDTO(refund) }, replay };
}
