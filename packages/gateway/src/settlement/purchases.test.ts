/**
 * approvePurchase when PayPal's answer to the capture goes missing (paypal-plan.md, audit): unknown, never failed.
 * The order is re-read; a capture found there is the purchase's, and one not found leaves it awaiting approval.
 */
import { describe, expect, it } from "vitest";
import type { PaypalClient } from "../context";
import { PaypalError } from "../paypal/errors";
import { approveMockOrder } from "../paypal/mock";
import { approvePurchase, checkoutPurchase, proposePurchase } from "./purchases";
import { loadPurchase } from "./store";
import { createHarness, openTab, type TestHarness } from "./testing";

/** A purchase the payer approved on the mock PayPal, not yet captured. */
async function approvedPurchase(h: TestHarness): Promise<{ purchaseId: string; orderId: string }> {
  const { tabId } = await openTab(h.ctx);
  const proposed = await proposePurchase(h.ctx, { tabId, title: "Standing desk", amountCents: 32_900, researchCostMicros: 0 });
  const { purchase } = await checkoutPurchase(h.ctx, proposed.id);
  const orderId = purchase.paypalOrderId ?? "";
  approveMockOrder(h.ctx.db, orderId);
  return { purchaseId: purchase.id, orderId };
}

/** Swap some PayPal calls and count the order re-reads. */
function withPaypal(h: TestHarness, overrides: (real: PaypalClient) => Partial<PaypalClient>): { real: PaypalClient; reads: () => number } {
  const real = h.ctx.paypal;
  let reads = 0;
  h.ctx.paypal = {
    ...real,
    mode: real.mode,
    getOrder: async (orderId) => {
      reads++;
      return real.getOrder(orderId);
    },
    ...overrides(real),
  } satisfies PaypalClient;
  return { real, reads: () => reads };
}

const lostAnswer = () => new PaypalError({ operation: "capture order", paypalName: "NETWORK_ERROR", message: "socket hang up" });

describe("approvePurchase when the capture's answer is lost", () => {
  it("finds the capture by re-reading the order and records the purchase as paid", async () => {
    const h = createHarness();
    const { purchaseId, orderId } = await approvedPurchase(h);
    const { reads } = withPaypal(h, (real) => ({
      captureOrder: async (id, requestId) => {
        await real.captureOrder(id, requestId);
        throw lostAnswer();
      },
    }));

    const message = await approvePurchase(h.ctx, purchaseId, orderId);
    expect(message.status).toBe("approved");
    expect(reads()).toBe(1);
    const row = loadPurchase(h.ctx.db, purchaseId);
    expect(row?.status).toBe("captured");
    expect(row?.capture_id).toMatch(/^MOCK-CAPTURE-/);
  });

  it("leaves the purchase awaiting approval when the order shows no capture, and a reload captures it", async () => {
    const h = createHarness();
    const { purchaseId, orderId } = await approvedPurchase(h);
    const { real, reads } = withPaypal(h, () => ({
      captureOrder: async () => {
        throw lostAnswer();
      },
    }));

    const message = await approvePurchase(h.ctx, purchaseId, orderId);
    expect(message.status).toBe("failed");
    expect(message.message).toContain("did not confirm");
    expect(reads()).toBe(1);
    expect(loadPurchase(h.ctx.db, purchaseId)?.status).toBe("awaiting_approval");

    h.ctx.paypal = real;
    expect((await approvePurchase(h.ctx, purchaseId, orderId)).status).toBe("approved");
    expect(loadPurchase(h.ctx.db, purchaseId)?.status).toBe("captured");
  });

  it("does not re-read when PayPal refused the capture or it was never sent", async () => {
    for (const refusal of [
      new PaypalError({ operation: "capture order", paypalName: "UNPROCESSABLE_ENTITY", message: "", issues: [{ issue: "INSTRUMENT_DECLINED" }], httpStatus: 422 }),
      new PaypalError({ operation: "OAuth token request", paypalName: "TIMEOUT", message: "PayPal did not answer in time" }),
    ]) {
      const h = createHarness();
      const { purchaseId, orderId } = await approvedPurchase(h);
      const { reads } = withPaypal(h, () => ({
        captureOrder: async () => {
          throw refusal;
        },
      }));

      expect((await approvePurchase(h.ctx, purchaseId, orderId)).status).toBe("failed");
      expect(reads()).toBe(0);
      expect(loadPurchase(h.ctx.db, purchaseId)?.status).toBe("failed");
    }
  });
});
