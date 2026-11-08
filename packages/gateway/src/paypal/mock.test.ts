import { captureFeeCents } from "@p402/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../clock";
import { openDb } from "../db/db";
import { PaypalError } from "./errors";
import { approveMockOrder, createMockPaypal, getMockOrder, inspectMockAuthorization } from "./mock";

function setup() {
  let now = Date.UTC(2026, 10, 8, 12);
  const db = openDb(":memory:");
  const deps = {
    config: { publicBaseUrl: "http://localhost:4020" },
    db,
    log: pino({ level: "silent" }),
    clock: { now: () => now },
  };
  return { db, deps, paypal: createMockPaypal(deps), advance: (ms: number) => void (now += ms) };
}

const hold = (requestId = "hold-tab_1", amountCents = 5_000) => ({
  referenceId: "tab_1",
  amountCents,
  description: "Agent spending tab",
  softDescriptor: "FIATALITY AGENT TAB",
  brandName: "402 Fiatality",
  returnUrl: "http://localhost:4020/paypal/return?kind=tab&ref=tab_1",
  cancelUrl: "http://localhost:4020/paypal/cancel?kind=tab&ref=tab_1",
  requestId,
});

async function expectPaypalError(promise: Promise<unknown>, issue: string): Promise<PaypalError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PaypalError);
  const error = err as PaypalError;
  expect(error.status).toBe(502);
  expect(error.code).toBe("paypal_error");
  expect(error.hasIssue(issue)).toBe(true);
  expect(error.debugId).toMatch(/^mock-/);
  expect(error.details).toMatchObject({ name: expect.any(String), debug_id: error.debugId, issues: [{ issue }] });
  return error;
}

describe("mock PayPal holds", () => {
  it("creates an approvable order and authorizes it after approval", async () => {
    const { db, paypal } = setup();
    const order = await paypal.createAuthorizeOrder(hold());
    expect(order.id).toMatch(/^MOCK-ORDER-[A-Z0-9]{12}$/);
    expect(order.status).toBe("PAYER_ACTION_REQUIRED");
    expect(order.approveUrl).toBe(`http://localhost:4020/paypal/mock/approve?token=${order.id}`);

    await expectPaypalError(paypal.authorizeOrder(order.id, "authorize-tab_1"), "ORDER_NOT_APPROVED");
    expect(approveMockOrder(db, order.id)?.status).toBe("APPROVED");
    expect((await paypal.getOrder(order.id)).approveUrl).toBeNull();

    const auth = await paypal.authorizeOrder(order.id, "authorize-tab_1");
    expect(auth).toMatchObject({ status: "CREATED", amountCents: 5_000 });
    expect(auth.id).toMatch(/^MOCK-AUTH-/);
    expect(auth.expiresAt).toBe(Date.UTC(2026, 10, 8, 12) + 29 * DAY_MS);
    expect(getMockOrder(db, order.id)?.status).toBe("COMPLETED");
  });

  it("honors PayPal-Request-Id and rejects a second authorization", async () => {
    const { db, paypal } = setup();
    const first = await paypal.createAuthorizeOrder(hold());
    expect((await paypal.createAuthorizeOrder(hold())).id).toBe(first.id);
    approveMockOrder(db, first.id);
    const auth = await paypal.authorizeOrder(first.id, "authorize-tab_1");
    expect((await paypal.authorizeOrder(first.id, "authorize-tab_1")).id).toBe(auth.id);
    await expectPaypalError(paypal.authorizeOrder(first.id, "another-request"), "ORDER_ALREADY_AUTHORIZED");
  });

  it("partially captures with final_capture and releases the rest", async () => {
    const { db, paypal } = setup();
    const order = await paypal.createAuthorizeOrder(hold());
    approveMockOrder(db, order.id);
    const auth = await paypal.authorizeOrder(order.id, "a1");
    const capture = await paypal.captureAuthorization(auth.id, {
      amountCents: 1_234,
      finalCapture: true,
      invoiceId: "stl_1",
      noteToPayer: "Agent API usage",
      requestId: "capture-stl_1",
    });
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 1_234, feeCents: captureFeeCents(1_234), finalCapture: true });
    expect((await paypal.getAuthorization(auth.id)).status).toBe("CAPTURED");
    expect(inspectMockAuthorization(db, auth.id)).toMatchObject({ capturedCents: 1_234, releasedCents: 5_000 - 1_234 });
    await expectPaypalError(
      paypal.captureAuthorization(auth.id, { amountCents: 1, finalCapture: true, invoiceId: "stl_2", noteToPayer: "", requestId: "c2" }),
      "AUTHORIZATION_ALREADY_CAPTURED",
    );
    await expectPaypalError(paypal.voidAuthorization(auth.id, "v1"), "AUTHORIZATION_ALREADY_CAPTURED");
  });

  it("caps captures at 115% / +$75 and rejects duplicate invoice ids", async () => {
    const { db, paypal } = setup();
    const order = await paypal.createAuthorizeOrder(hold("h", 1_000));
    approveMockOrder(db, order.id);
    const auth = await paypal.authorizeOrder(order.id, "a");
    const capture = (amountCents: number, invoiceId: string, requestId: string) =>
      paypal.captureAuthorization(auth.id, { amountCents, finalCapture: false, invoiceId, noteToPayer: "", requestId });
    await expectPaypalError(capture(1_151, "i1", "r1"), "MAX_CAPTURE_AMOUNT_EXCEEDED");
    await capture(500, "i1", "r2");
    expect((await paypal.getAuthorization(auth.id)).status).toBe("PARTIALLY_CAPTURED");
    await expectPaypalError(capture(100, "i1", "r3"), "DUPLICATE_INVOICE_ID");
    await expectPaypalError(capture(0, "i2", "r4"), "CANNOT_BE_ZERO_OR_NEGATIVE");
  });

  it("reauthorizes once, only after the honor window, and expires after 29 days", async () => {
    const { db, paypal, advance } = setup();
    const order = await paypal.createAuthorizeOrder(hold());
    approveMockOrder(db, order.id);
    const auth = await paypal.authorizeOrder(order.id, "a");

    await expectPaypalError(paypal.reauthorize(auth.id, 5_000, "re-1"), "REAUTHORIZE_TOO_SOON");
    advance(4 * DAY_MS);
    await expectPaypalError(paypal.reauthorize(auth.id, 20_000, "re-2"), "MAX_AUTHORIZATION_AMOUNT_EXCEEDED");
    const reauth = await paypal.reauthorize(auth.id, 5_000, "re-3");
    expect(reauth.id).not.toBe(auth.id);
    expect(reauth.expiresAt).toBe(auth.expiresAt);
    expect((await paypal.reauthorize(auth.id, 5_000, "re-3")).id).toBe(reauth.id);
    await expectPaypalError(paypal.reauthorize(reauth.id, 5_000, "re-4"), "REAUTHORIZATION_LIMIT_REACHED");

    advance(26 * DAY_MS);
    expect((await paypal.getAuthorization(reauth.id)).status).toBe("EXPIRED");
    await expectPaypalError(
      paypal.captureAuthorization(reauth.id, { amountCents: 100, finalCapture: true, invoiceId: "x", noteToPayer: "", requestId: "c" }),
      "AUTHORIZATION_EXPIRED",
    );
  });

  it("voids a hold once", async () => {
    const { db, paypal } = setup();
    const order = await paypal.createAuthorizeOrder(hold());
    approveMockOrder(db, order.id);
    const auth = await paypal.authorizeOrder(order.id, "a");
    await paypal.voidAuthorization(auth.id, "void-1");
    await paypal.voidAuthorization(auth.id, "void-1");
    expect(inspectMockAuthorization(db, auth.id)).toMatchObject({ status: "VOIDED", releasedCents: 5_000 });
    await expectPaypalError(paypal.voidAuthorization(auth.id, "void-2"), "AUTHORIZATION_VOIDED");
  });

  it("survives a gateway restart (state lives in SQLite)", async () => {
    const { db, deps, paypal } = setup();
    const order = await paypal.createAuthorizeOrder(hold());
    approveMockOrder(db, order.id);
    const auth = await paypal.authorizeOrder(order.id, "a");
    const restarted = createMockPaypal(deps);
    expect((await restarted.getAuthorization(auth.id)).status).toBe("CREATED");
    expect((await restarted.getOrder(order.id)).status).toBe("COMPLETED");
  });

  it("captures an approved CAPTURE order once", async () => {
    const { db, paypal } = setup();
    const order = await paypal.createCaptureOrder({
      referenceId: "pur_1",
      amountCents: 14_900,
      itemName: "Espresso machine",
      description: "Agent purchase",
      brandName: "402 Fiatality",
      returnUrl: "http://localhost:4020/paypal/return?kind=purchase&ref=pur_1",
      cancelUrl: "http://localhost:4020/paypal/cancel?kind=purchase&ref=pur_1",
      requestId: "checkout-pur_1",
    });
    await expectPaypalError(paypal.captureOrder(order.id, "c1"), "ORDER_NOT_APPROVED");
    approveMockOrder(db, order.id);
    await expectPaypalError(paypal.authorizeOrder(order.id, "a1"), "ACTION_DOES_NOT_MATCH_INTENT");
    const capture = await paypal.captureOrder(order.id, "c1");
    expect(capture).toMatchObject({ status: "COMPLETED", amountCents: 14_900, feeCents: captureFeeCents(14_900) });
    expect((await paypal.captureOrder(order.id, "c1")).id).toBe(capture.id);
    await expectPaypalError(paypal.captureOrder(order.id, "c2"), "ORDER_ALREADY_CAPTURED");
  });

  it("rejects unknown ids with RESOURCE_NOT_FOUND", async () => {
    const { paypal } = setup();
    const err = await expectPaypalError(paypal.getAuthorization("MOCK-AUTH-NOPE"), "INVALID_RESOURCE_ID");
    expect(err.httpStatus).toBe(404);
  });
});

describe("mock PayPal payouts", () => {
  it("pays immediately with a $0.25 fee per item and fails undeliverable items", async () => {
    const { paypal } = setup();
    const batch = await paypal.createPayoutBatch({
      senderBatchId: "po_1",
      emailSubject: "Payout",
      note: "402 Fiatality weekly payout",
      items: [
        { senderItemId: "po_1:channel3", receiverEmail: "channel3@example.com", amountCents: 975, note: "n" },
        { senderItemId: "po_1:reviews", receiverEmail: "not-an-email", amountCents: 500, note: "n" },
      ],
    });
    expect(batch.batchId).toMatch(/^MOCK-BATCH-/);
    expect(batch.status).toBe("SUCCESS");
    expect(batch.items).toEqual([
      { senderItemId: "po_1:channel3", payoutItemId: expect.stringMatching(/^MOCK-ITEM-/), status: "SUCCESS", amountCents: 975, feeCents: 25 },
      { senderItemId: "po_1:reviews", payoutItemId: expect.stringMatching(/^MOCK-ITEM-/), status: "FAILED", amountCents: 500, feeCents: 0 },
    ]);
    expect(await paypal.getPayoutBatch(batch.batchId)).toEqual(batch);
    const again = await paypal.createPayoutBatch({ senderBatchId: "po_1", emailSubject: "", note: "", items: [] });
    expect(again.batchId).toBe(batch.batchId);
  });
});
