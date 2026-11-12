/**
 * The agent's retail purchase (SPEC §6.6): the agent proposes, a human approves a CAPTURE order on PayPal,
 * the return handler captures it. The research spend is attached ("research $0.37 -> purchase $149").
 */
import {
  formatUsd,
  newId,
  type PaypalReturnMessage,
  type PurchaseCheckoutDTO,
  type PurchaseDTO,
  type PurchaseProposalDTO,
} from "@p402/shared";
import { AppError } from "../context";
import { stmt } from "../db/db";
import type { PurchaseRow } from "../db/dto";
import { outcomeUnknown, PaypalError } from "../paypal/errors";
import { BRAND_NAME, paypalReturnUrls, returnMessage } from "./holds";
import { emitPurchase, errorFields, loadPurchase, purchaseView, requireTab, type SettlementContext, withLock } from "./store";

function requirePurchase(ctx: SettlementContext, id: string): PurchaseRow {
  const row = loadPurchase(ctx.db, id);
  if (!row) throw new AppError(404, "not_found", `Purchase ${id} was not found.`);
  return row;
}

/** POST /api/purchases (input validated by the route). */
export async function proposePurchase(ctx: SettlementContext, input: PurchaseProposalDTO): Promise<PurchaseDTO> {
  requireTab(ctx.db, input.tabId);
  const id = newId("pur");
  stmt(
    ctx.db,
    `INSERT INTO purchases (id, tab_id, title, amount_cents, merchant, product_url, image_url, status,
                            research_cost_micros, reasoning, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
  ).run(
    id,
    input.tabId,
    input.title,
    input.amountCents,
    input.merchant ?? null,
    input.productUrl ?? null,
    input.imageUrl ?? null,
    input.researchCostMicros,
    input.reasoning ?? null,
    ctx.clock.now(),
  );
  emitPurchase(ctx, id);
  ctx.log.info({ purchaseId: id, tabId: input.tabId, amountCents: input.amountCents }, "purchase proposed");
  return purchaseView(ctx.db, requirePurchase(ctx, id));
}

/**
 * POST /api/purchases/:id/checkout: the CAPTURE order a human approves. Idempotent: an order awaiting
 * approval is returned as is; after a cancel or failure the same PayPal-Request-Id brings back the order.
 */
export async function checkoutPurchase(ctx: SettlementContext, purchaseId: string): Promise<PurchaseCheckoutDTO> {
  return withLock(ctx.db, `purchase:${purchaseId}`, async () => {
    const row = requirePurchase(ctx, purchaseId);
    if (row.status === "captured") throw new AppError(409, "purchase_captured", "This purchase was already paid.");
    if (row.status === "awaiting_approval" && row.approve_url) return { purchase: purchaseView(ctx.db, row), approveUrl: row.approve_url };

    const research = `${formatUsd(row.research_cost_micros)} of agent research`;
    const order = await ctx.paypal.createCaptureOrder({
      referenceId: row.id,
      amountCents: row.amount_cents,
      itemName: row.title,
      description: (row.merchant ? `${row.merchant} - ${research}` : `Agent purchase after ${research}`).slice(0, 127),
      brandName: BRAND_NAME,
      ...paypalReturnUrls(ctx.config.publicBaseUrl, "purchase", row.id),
      requestId: `checkout-${row.id}`,
    });
    if (!order.approveUrl) {
      throw new PaypalError({ operation: "create purchase order", paypalName: "INVALID_RESPONSE", message: "PayPal returned no approval link" });
    }
    stmt(ctx.db, "UPDATE purchases SET paypal_order_id = ?, approve_url = ?, status = 'awaiting_approval' WHERE id = ?").run(
      order.id,
      order.approveUrl,
      row.id,
    );
    emitPurchase(ctx, row.id);
    return { purchase: purchaseView(ctx.db, requirePurchase(ctx, row.id)), approveUrl: order.approveUrl };
  });
}

/** /paypal/return?kind=purchase: capture the approved order. Idempotent. */
export async function approvePurchase(ctx: SettlementContext, purchaseId: string, orderId: string): Promise<PaypalReturnMessage> {
  return withLock(ctx.db, `purchase:${purchaseId}`, async () => {
    const row = loadPurchase(ctx.db, purchaseId);
    if (!row) return returnMessage("purchase", purchaseId, "failed", "This purchase does not exist.");
    if (row.paypal_order_id !== orderId) {
      return returnMessage("purchase", purchaseId, "failed", "This PayPal approval does not belong to this purchase.");
    }
    if (row.status === "captured") return returnMessage("purchase", purchaseId, "approved");

    try {
      const capture = await ctx.paypal.captureOrder(orderId, `capture-${purchaseId}`);
      if (capture.status !== "COMPLETED" && capture.status !== "PENDING") {
        throw new PaypalError({ operation: "capture order", paypalName: capture.status, message: `PayPal returned the capture as ${capture.status}` });
      }
      stmt(ctx.db, "UPDATE purchases SET status = 'captured', capture_id = ? WHERE id = ?").run(capture.id, purchaseId);
      emitPurchase(ctx, purchaseId);
      ctx.log.info({ purchaseId, captureId: capture.id, amountCents: capture.amountCents }, "purchase captured");
      return returnMessage("purchase", purchaseId, "approved");
    } catch (err) {
      // No answer, an unreadable one or a 5xx: PayPal may have taken the money, so the outcome is unknown, not failed.
      if (outcomeUnknown(err, "capture order")) return settleLostCapture(ctx, purchaseId, orderId);
      stmt(ctx.db, "UPDATE purchases SET status = 'failed' WHERE id = ? AND status != 'captured'").run(purchaseId);
      emitPurchase(ctx, purchaseId);
      ctx.log.warn({ purchaseId, orderId }, "purchase capture failed");
      return returnMessage("purchase", purchaseId, "failed", err instanceof Error ? err.message : "PayPal could not complete the payment.");
    }
  });
}

/**
 * After a capture whose answer was lost: re-read the order. Captured there, the purchase is captured here; otherwise
 * it stays awaiting approval (never failed), and reloading the return page asks again with the same request id.
 */
async function settleLostCapture(ctx: SettlementContext, purchaseId: string, orderId: string): Promise<PaypalReturnMessage> {
  let captureId: string | null = null;
  try {
    const order = await ctx.paypal.getOrder(orderId);
    if (order.status === "COMPLETED") captureId = order.captureId ?? null;
  } catch (err) {
    ctx.log.warn({ purchaseId, orderId, ...errorFields(err) }, "purchase order re-read failed");
  }
  if (!captureId) {
    ctx.log.warn({ purchaseId, orderId }, "purchase capture outcome unknown");
    return returnMessage("purchase", purchaseId, "failed", "PayPal did not confirm the payment yet. Reload this page in a minute to check again.");
  }
  stmt(ctx.db, "UPDATE purchases SET status = 'captured', capture_id = ? WHERE id = ?").run(captureId, purchaseId);
  emitPurchase(ctx, purchaseId);
  ctx.log.info({ purchaseId, captureId }, "purchase captured (found by re-reading the order)");
  return returnMessage("purchase", purchaseId, "approved");
}

/** /paypal/cancel?kind=purchase. Idempotent. */
export async function cancelPurchase(ctx: SettlementContext, purchaseId: string, orderId: string): Promise<PaypalReturnMessage> {
  return withLock(ctx.db, `purchase:${purchaseId}`, async () => {
    const row = loadPurchase(ctx.db, purchaseId);
    if (!row) return returnMessage("purchase", purchaseId, "failed", "This purchase does not exist.");
    if (row.paypal_order_id !== orderId) {
      return returnMessage("purchase", purchaseId, "failed", "This PayPal approval does not belong to this purchase.");
    }
    if (row.status === "captured") return returnMessage("purchase", purchaseId, "approved", "This purchase was already paid.");
    if (row.status === "awaiting_approval") {
      stmt(ctx.db, "UPDATE purchases SET status = 'cancelled' WHERE id = ?").run(purchaseId);
      emitPurchase(ctx, purchaseId);
    }
    return returnMessage("purchase", purchaseId, "cancelled");
  });
}
