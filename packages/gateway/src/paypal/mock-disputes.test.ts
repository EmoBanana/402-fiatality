/** The mock PayPal's disputes (on the demo clock), refunds and invoice records. */
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../clock";
import { createTestContext, type AppContext } from "../context";
import { createPaypalClient } from "./index";
import { approveMockOrder, inspectMockDispute, MOCK_PAYER_EMAIL, openMockDispute } from "./mock";
import { PaypalError } from "./errors";

const T0 = Date.UTC(2026, 10, 10, 12);

async function charged(amountCents = 1_234) {
  let now = T0;
  const ctx: AppContext = createTestContext({ realNow: () => now });
  const paypal = createPaypalClient(ctx);
  const order = await paypal.createAuthorizeOrder({
    referenceId: "tab_1",
    amountCents: 5_000,
    description: "Agent spending tab",
    softDescriptor: "FIATALITY AGENT TAB",
    brandName: "402 Fiatality",
    returnUrl: "http://localhost:4020/paypal/return",
    cancelUrl: "http://localhost:4020/paypal/cancel",
    requestId: "hold-tab_1",
  });
  approveMockOrder(ctx.db, order.id);
  const auth = await paypal.authorizeOrder(order.id, "authorize-tab_1");
  const capture = await paypal.captureAuthorization(auth.id, { amountCents, finalCapture: true, invoiceId: "stl_1", noteToPayer: "", requestId: "capture-stl_1" });
  return { ctx, paypal, order, capture, advance: (ms: number) => void (now += ms) };
}

describe("mock disputes", () => {
  it("opens an inquiry waiting for the seller and lists it", async () => {
    const { ctx, paypal, capture, order } = await charged();
    expect((await paypal.getOrder(order.id)).payerEmail).toBe(MOCK_PAYER_EMAIL);
    const opened = openMockDispute(ctx, { captureId: capture.id, reason: "UNAUTHORISED", message: "I never approved this." });
    expect(opened).toMatchObject({
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "INQUIRY",
      reason: "UNAUTHORISED",
      amountCents: 1_234,
      captureIds: [capture.id],
      outcome: null,
      refundedCents: null,
      buyerMessage: "I never approved this.",
      sellerResponseDueAt: T0 + 10 * DAY_MS,
    });
    expect(opened.id).toMatch(/^MOCK-D-/);
    expect(opened.actions).toEqual(expect.arrayContaining(["provide_evidence", "send_message", "make_offer", "accept_claim"]));
    expect(await paypal.listDisputes()).toEqual([expect.objectContaining({ id: opened.id, status: "WAITING_FOR_SELLER_RESPONSE" })]);
    expect(await paypal.listDisputes({ updatedAfter: T0 })).toEqual([]);
    expect(await paypal.listDisputes({ disputedTransactionId: "OTHER" })).toEqual([]);
    // One open dispute per charge, and never more than the charge.
    expect(() => openMockDispute(ctx, { captureId: capture.id })).toThrow(PaypalError);
    expect(() => openMockDispute(ctx, { captureId: "MOCK-CAPTURE-NOPE" })).toThrow(/No mock capture/);
  });

  it("puts evidence under review, then settles it in the seller's favour", async () => {
    const { ctx, paypal, capture } = await charged();
    const { id } = openMockDispute(ctx, { captureId: capture.id });
    await paypal.provideDisputeEvidence(id, { notes: "Every call was signed.", evidenceType: "OTHER" });
    expect(await paypal.getDispute(id)).toMatchObject({ status: "UNDER_REVIEW", actions: expect.arrayContaining(["adjudicate"]) });
    await expect(paypal.provideDisputeEvidence(id, { notes: "again" })).rejects.toMatchObject({ httpStatus: 422 });
    await paypal.adjudicateDispute(id, "SELLER_FAVOR");
    expect(await paypal.getDispute(id)).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR", refundedCents: 0, actions: [] });
    await expect(paypal.adjudicateDispute(id, "BUYER_FAVOR")).rejects.toMatchObject({ httpStatus: 422 });
    expect(inspectMockDispute(ctx.db, id)?.evidences).toEqual([{ type: "OTHER", notes: "Every call was signed.", at: T0 }]);
  });

  it("lets the mock buyer take an offer, and refunds partial claims", async () => {
    const { ctx, paypal, capture } = await charged();
    const a = openMockDispute(ctx, { captureId: capture.id, amountCents: 1_000 });
    await expect(paypal.makeDisputeOffer(a.id, { amountCents: 1_001, note: "too much" })).rejects.toMatchObject({ httpStatus: 422 });
    await paypal.makeDisputeOffer(a.id, { amountCents: 250, note: "Goodwill refund of the repeats." });
    expect(await paypal.getDispute(a.id)).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", refundedCents: 250 });

    const b = openMockDispute(ctx, { captureId: capture.id, amountCents: 900 });
    await paypal.acceptDisputeClaim(b.id, { note: "Fair.", refundCents: 300 });
    expect(await paypal.getDispute(b.id)).toMatchObject({ status: "RESOLVED", refundedCents: 300 });
    // 1,234 - 250 - 300 = 684 cents are left of the capture.
    expect(() => openMockDispute(ctx, { captureId: capture.id, amountCents: 685 })).toThrow(/1 to 684 cents/);
    await expect(paypal.refundCapture(capture.id, { amountCents: 685, invoiceId: "r", noteToPayer: "", requestId: "refund-1" })).rejects.toMatchObject({ httpStatus: 422 });
    const refund = await paypal.refundCapture(capture.id, { invoiceId: "r", noteToPayer: "", requestId: "refund-2" });
    expect(refund).toMatchObject({ status: "COMPLETED", amountCents: 684 });
    expect(refund.id).toMatch(/^MOCK-REFUND-/);
    expect(() => openMockDispute(ctx, { captureId: capture.id })).toThrow(/already refunded in full/);
    expect(await paypal.refundCapture(capture.id, { invoiceId: "r", noteToPayer: "", requestId: "refund-2" })).toEqual(refund);
  });

  it("closes in the buyer's favour when the seller misses the deadline", async () => {
    const { ctx, paypal, capture, advance } = await charged();
    const { id } = openMockDispute(ctx, { captureId: capture.id });
    advance(9 * DAY_MS);
    expect((await paypal.getDispute(id)).status).toBe("WAITING_FOR_SELLER_RESPONSE");
    advance(DAY_MS);
    expect(await paypal.getDispute(id)).toMatchObject({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR", refundedCents: 1_234, updatedAt: T0 + 10 * DAY_MS });
    expect(await paypal.listDisputes({ updatedAfter: T0 })).toHaveLength(1);
  });

  it("escalates an inquiry and asks for evidence", async () => {
    const { ctx, paypal, capture } = await charged();
    const { id } = openMockDispute(ctx, { captureId: capture.id });
    await paypal.sendDisputeMessage(id, "We can explain the charge.");
    expect((await paypal.getDispute(id)).status).toBe("WAITING_FOR_BUYER_RESPONSE");
    await paypal.escalateDispute(id, "Escalate");
    expect(await paypal.getDispute(id)).toMatchObject({ stage: "CHARGEBACK", status: "UNDER_REVIEW" });
    await expect(paypal.sendDisputeMessage(id, "hi")).rejects.toMatchObject({ httpStatus: 422 });
    await paypal.requireDisputeEvidence(id, "SELLER_EVIDENCE");
    expect((await paypal.getDispute(id)).status).toBe("WAITING_FOR_SELLER_RESPONSE");
  });
});

describe("mock invoice records", () => {
  it("records a paid invoice once per invoice number", async () => {
    const { paypal } = await charged();
    const input = {
      invoiceNumber: "FIAT-stl_1",
      reference: "tab_1",
      recipientEmail: MOCK_PAYER_EMAIL,
      itemName: "Agent API usage",
      itemDescription: "Channel3: 3 calls",
      amountCents: 1_234,
      note: "Paid",
      memo: "memo",
      paymentNote: "Paid by capture",
      requestId: "invoice-stl_1",
    };
    const invoice = await paypal.createInvoiceRecord(input);
    expect(invoice).toMatchObject({ invoiceNumber: "FIAT-stl_1", status: "MARKED_AS_PAID", amountCents: 1_234, url: null });
    expect(invoice.id).toMatch(/^MOCK-INV-/);
    expect(await paypal.createInvoiceRecord(input)).toEqual(invoice);
    await expect(paypal.createInvoiceRecord({ ...input, invoiceNumber: "X".repeat(26) })).rejects.toMatchObject({ httpStatus: 422 });
  });
});
