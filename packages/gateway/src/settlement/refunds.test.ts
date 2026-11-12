/**
 * Purchase refunds (paypal-plan.md) through POST /api/purchases/:id/refund on the mock PayPal: the claim, the same key
 * answering with the same refund, the invariants checked before PayPal is asked, a lost answer settled by re-reading
 * the order, and PayPal's refusals mapped to what the caller reads.
 */
import type { PurchaseDTO, PurchaseRefundResultDTO } from "@p402/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AppError, type AppContext, type PaypalClient } from "../context";
import { stmt } from "../db/db";
import type { PurchaseRefundRow } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import { approveMockOrder } from "../paypal/mock";
import { settlementRoutes } from "../routes/settlement";
import { approvePurchase, checkoutPurchase, proposePurchase } from "./purchases";
import { createHarness, openTab, type TestHarness } from "./testing";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function build(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number; issues?: unknown }, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.name === "ZodError") return reply.code(400).send({ error: "invalid_request", message: "Invalid request", details: err.issues });
    return reply.code(500).send({ error: "error", message: err.message });
  });
  await app.register(settlementRoutes, { ctx });
  await app.ready();
  apps.push(app);
  return app;
}

/** A $329.00 purchase, proposed and paid on the mock PayPal. */
async function paidPurchase(h: TestHarness, tabId?: string): Promise<PurchaseDTO> {
  const tab = tabId ?? (await openTab(h.ctx)).tabId;
  const proposed = await proposePurchase(h.ctx, { tabId: tab, title: "Standing desk", amountCents: 32_900, merchant: "Example Desks", researchCostMicros: 412_000 });
  const { purchase } = await checkoutPurchase(h.ctx, proposed.id);
  approveMockOrder(h.ctx.db, purchase.paypalOrderId ?? "");
  const message = await approvePurchase(h.ctx, purchase.id, purchase.paypalOrderId ?? "");
  expect(message.status).toBe("approved");
  return purchase;
}

const refunds = (h: TestHarness, purchaseId: string) =>
  stmt(h.ctx.db, "SELECT * FROM purchase_refunds WHERE purchase_id = ? ORDER BY created_at, rowid").all(purchaseId) as PurchaseRefundRow[];

/** Swap some PayPal calls; the rest stay on the mock. */
function withPaypal(h: TestHarness, overrides: Partial<PaypalClient>): PaypalClient {
  const real = h.ctx.paypal;
  h.ctx.paypal = { ...real, mode: real.mode, ...overrides } satisfies PaypalClient;
  return real;
}

const lostAnswer = () => new PaypalError({ operation: "refund capture", paypalName: "TIMEOUT", message: "PayPal did not answer in time" });

describe("POST /api/purchases/:id/refund", () => {
  it("refunds part, then the rest, and shows both on the purchase and the statement", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    const refund = (payload: object) => app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload });

    const part = await refund({ amountCents: 10_000, idempotencyKey: "key-part-0001" });
    expect(part.statusCode).toBe(201);
    const first = part.json<PurchaseRefundResultDTO>();
    expect(first.refund).toMatchObject({ amountCents: 10_000, status: "completed", error: null });
    expect(first.refund.paypalRefundId).toMatch(/^MOCK-REFUND-/);
    expect(first.purchase).toMatchObject({ status: "captured", refundedCents: 10_000 });

    const rest = await refund({ idempotencyKey: "key-rest-0001" });
    expect(rest.statusCode).toBe(201);
    expect(rest.json<PurchaseRefundResultDTO>().refund.amountCents).toBe(22_900);
    expect(rest.json<PurchaseRefundResultDTO>().purchase.refundedCents).toBe(32_900);

    const more = await refund({ idempotencyKey: "key-more-0001" });
    expect(more.statusCode).toBe(409);
    expect(more.json()).toMatchObject({ error: "purchase_refunded" });
    expect(h.calls.refundCapture).toBe(2);

    const statement = await h.ctx.settlement.statement(purchase.tabId ?? "");
    expect(statement.purchases?.[0]).toMatchObject({ id: purchase.id, refundedCents: 32_900 });
    expect(statement.purchases?.[0]?.refunds?.map((r) => r.amountCents)).toEqual([22_900, 10_000]);
    const listed = (await app.inject({ method: "GET", url: "/api/purchases" })).json<PurchaseDTO[]>();
    expect(listed[0]?.refunds).toHaveLength(2);
    const updates = h.events.flatMap((e) => (e.type === "purchase.updated" ? [e.data] : []));
    expect(updates.at(-1)?.refundedCents).toBe(32_900);

    // PayPal holds each refund under the reference we sent: invoice_id refund-<claim id>.
    const order = await h.ctx.paypal.getOrder(purchase.paypalOrderId ?? "");
    expect(order.refunds?.map((r) => r.invoiceId).sort()).toEqual(refunds(h, purchase.id).map((r) => `refund-${r.id}`).sort());
  });

  it("answers the same key with the same refund and asks PayPal once, even for a double click", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    const payload = { amountCents: 5_000, idempotencyKey: "key-same-0001" };
    const send = () => app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload });

    const [one, two] = await Promise.all([send(), send()]);
    expect([one.statusCode, two.statusCode].sort()).toEqual([200, 201]);
    expect(one.json<PurchaseRefundResultDTO>().refund).toEqual(two.json<PurchaseRefundResultDTO>().refund);
    const three = await send();
    expect(three.statusCode).toBe(200);
    expect(three.json<PurchaseRefundResultDTO>().refund).toEqual(one.json<PurchaseRefundResultDTO>().refund);

    expect(h.calls.refundCapture).toBe(1);
    expect(refunds(h, purchase.id)).toHaveLength(1);
    expect(three.json<PurchaseRefundResultDTO>().purchase.refundedCents).toBe(5_000);
  });

  it("refuses a refund it may not make before asking PayPal", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const { tabId } = await openTab(h.ctx);
    const refund = (purchaseId: string, payload: object) => app.inject({ method: "POST", url: `/api/purchases/${purchaseId}/refund`, payload });

    const unpaid = await proposePurchase(h.ctx, { tabId, title: "Lamp", amountCents: 4_500, researchCostMicros: 0 });
    const notPaid = await refund(unpaid.id, {});
    expect(notPaid.statusCode).toBe(409);
    expect(notPaid.json()).toMatchObject({ error: "purchase_not_paid" });

    const purchase = await paidPurchase(h, tabId);
    const tooMuch = await refund(purchase.id, { amountCents: 40_000 });
    expect(tooMuch.statusCode).toBe(409);
    expect(tooMuch.json()).toMatchObject({ error: "refund_too_large" });
    expect(tooMuch.json<{ message: string }>().message).toContain("$329.00");

    expect((await refund("pur_missing", {})).statusCode).toBe(404);
    expect((await refund(purchase.id, { idempotencyKey: "short" })).statusCode).toBe(400);
    expect((await refund(purchase.id, { amountCents: 0 })).statusCode).toBe(400);
    expect(h.calls.refundCapture ?? 0).toBe(0);
    expect(refunds(h, purchase.id)).toHaveLength(0);
  });

  it("settles a refund whose answer was lost by re-reading the order", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    let reads = 0;
    const real = withPaypal(h, {
      // PayPal made the refund; its answer never reached us.
      refundCapture: async (captureId, input) => {
        await real.refundCapture(captureId, input);
        throw lostAnswer();
      },
      getOrder: async (orderId) => {
        reads++;
        return real.getOrder(orderId);
      },
    });

    const res = await app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload: { amountCents: 2_500, idempotencyKey: "key-lost-0001" } });
    expect(res.statusCode).toBe(201);
    expect(reads).toBe(1);
    const body = res.json<PurchaseRefundResultDTO>();
    expect(body.refund).toMatchObject({ amountCents: 2_500, status: "completed" });
    expect(body.refund.paypalRefundId).toMatch(/^MOCK-REFUND-/);
    expect(body.purchase.refundedCents).toBe(2_500);
  });

  it("keeps a refund PayPal never confirmed as unknown, holds its amount, and settles it when the key asks again", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    let reads = 0;
    const real = withPaypal(h, {
      refundCapture: async () => {
        throw lostAnswer();
      },
      getOrder: async (orderId) => {
        reads++;
        return real.getOrder(orderId);
      },
    });
    const refund = (payload: object) => app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload });

    const first = await refund({ amountCents: 30_000, idempotencyKey: "key-unknown-01" });
    expect(first.statusCode).toBe(202);
    expect(reads).toBe(1);
    const unknown = first.json<PurchaseRefundResultDTO>().refund;
    expect(unknown).toMatchObject({ status: "unknown", amountCents: 30_000 });
    expect(unknown.error).toContain("same key");

    // Not failed: the unconfirmed refund still holds its amount.
    expect((await refund({ amountCents: 5_000, idempotencyKey: "key-unknown-02" })).statusCode).toBe(409);

    h.ctx.paypal = real;
    const again = await refund({ amountCents: 30_000, idempotencyKey: "key-unknown-01" });
    expect(again.statusCode).toBe(200);
    expect(again.json<PurchaseRefundResultDTO>().refund).toMatchObject({ id: unknown.id, status: "completed", error: null });
    expect(refunds(h, purchase.id)).toHaveLength(1);
  });

  it("never re-reads a refund that was never sent, and lets the same key try again", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    let reads = 0;
    const real = withPaypal(h, {
      refundCapture: async () => {
        throw new PaypalError({ operation: "OAuth token request", paypalName: "invalid_client", message: "Client Authentication failed", httpStatus: 401 });
      },
      getOrder: async (orderId) => {
        reads++;
        return real.getOrder(orderId);
      },
    });
    const refund = () => app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload: { idempotencyKey: "key-token-0001" } });

    const res = await refund();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: "paypal_unavailable", message: "PayPal refused our credentials. Nothing was refunded." });
    expect(reads).toBe(0);
    expect(refunds(h, purchase.id)).toHaveLength(0);

    h.ctx.paypal = real;
    expect((await refund()).statusCode).toBe(201);
  });

  it("passes PayPal's reason through when the caller can act on it, and keeps the refusal on record", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    withPaypal(h, {
      refundCapture: async () => {
        throw new PaypalError({
          operation: "refund capture",
          paypalName: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed.",
          debugId: "dbg-422",
          issues: [{ issue: "REFUND_AMOUNT_EXCEEDED", description: "The refund amount must be less than or equal to the capture amount that has not yet been refunded." }],
          httpStatus: 422,
        });
      },
    });

    const res = await app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload: { amountCents: 1_000, idempotencyKey: "key-422-00001" } });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "refund_rejected", details: { debug_id: "dbg-422" } });
    expect(res.json<{ message: string }>().message).toContain("The refund amount must be less than or equal");
    expect(refunds(h, purchase.id)).toMatchObject([{ status: "rejected", amount_cents: 1_000 }]);
    expect(refunds(h, purchase.id)[0]?.error).toContain("REFUND_AMOUNT_EXCEEDED");
  });

  it("answers our own credential and quota problems as ours, not the caller's", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const purchase = await paidPurchase(h);
    const refused = (httpStatus: number) => async () => {
      throw new PaypalError({ operation: "refund capture", paypalName: httpStatus === 429 ? "RATE_LIMIT_REACHED" : "NOT_AUTHORIZED", message: "", httpStatus });
    };
    const refund = (key: string) => app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/refund`, payload: { idempotencyKey: key } });

    withPaypal(h, { refundCapture: refused(403) });
    const forbidden = await refund("key-403-00001");
    expect(forbidden.statusCode).toBe(502);
    expect(forbidden.json()).toMatchObject({ message: "PayPal refused our credentials. Nothing was refunded." });

    withPaypal(h, { refundCapture: refused(429) });
    const busy = await refund("key-429-00001");
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ error: "paypal_busy" });
    expect(refunds(h, purchase.id)).toHaveLength(0);
  });
});
