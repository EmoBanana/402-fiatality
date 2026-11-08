import { MICROS_PER_CENT } from "@p402/shared";
import { describe, expect, it } from "vitest";
import type { PaypalClient } from "../context";
import { stmt } from "../db/db";
import { PaypalError } from "../paypal/errors";
import { addVouchers, balanceOf, createHarness, openTab, setBalance } from "./testing";

describe("runPayouts", () => {
  it("pays sellers over the threshold their floored balance minus the $0.25 fee", async () => {
    const h = createHarness();
    setBalance(h.ctx, "channel3", 12_345_678); // $12.345678
    setBalance(h.ctx, "pricewatch", 9_990_000); // $9.99: below $10

    const payout = await h.ctx.settlement.runPayouts();
    expect(payout).toMatchObject({
      status: "success",
      totalCents: 1_234 - 25,
      feeCents: 25,
      items: [{ sellerId: "channel3", sellerName: "Channel3", amountCents: 1_209, feeCents: 25, status: "SUCCESS" }],
    });
    expect(payout?.paypalBatchId).toMatch(/^MOCK-BATCH-/);
    expect(payout?.items[0]?.paypalItemId).toMatch(/^MOCK-ITEM-/);
    // Only the whole cents leave; the sub-cent dust stays for next week.
    expect(balanceOf(h.ctx, "channel3")).toEqual({ available: 5_678, paidOut: 1_209 * MICROS_PER_CENT });
    expect(balanceOf(h.ctx, "pricewatch")).toEqual({ available: 9_990_000, paidOut: 0 });

    const completed = h.events.filter((e) => e.type === "payout.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({ id: payout?.id, status: "success" });
    expect(h.events.filter((e) => e.type === "seller.updated").map((e) => e.data.id)).toEqual(["channel3"]);
    expect(h.calls.createPayoutBatch).toBe(1);
  });

  it("returns null when nobody is owed enough, and never pays twice", async () => {
    const h = createHarness();
    expect(await h.ctx.settlement.runPayouts()).toBeNull();
    setBalance(h.ctx, "channel3", 20_000_000);
    const [a, b] = await Promise.all([h.ctx.settlement.runPayouts(), h.ctx.settlement.runPayouts()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await h.ctx.settlement.runPayouts()).toBeNull();
    expect(balanceOf(h.ctx, "channel3")).toEqual({ available: 0, paidOut: 1_975 * MICROS_PER_CENT });
  });

  it("accepts a lower demo threshold but never sends less than a cent", async () => {
    const h = createHarness();
    setBalance(h.ctx, "channel3", 600_000); // $0.60
    setBalance(h.ctx, "reviews", 250_000); // $0.25: nothing left after the fee
    const payout = await h.ctx.settlement.runPayouts({ thresholdCents: 1 });
    expect(payout?.items.map((i) => [i.sellerId, i.amountCents])).toEqual([["channel3", 35]]);
    expect(balanceOf(h.ctx, "reviews").available).toBe(250_000);
    await expect(h.ctx.settlement.runPayouts({ thresholdCents: 0 })).rejects.toMatchObject({ status: 400 });
  });

  it("gives the money back when PayPal rejects the batch", async () => {
    const h = createHarness();
    setBalance(h.ctx, "channel3", 15_000_000);
    const real = h.ctx.paypal;
    h.ctx.paypal = {
      ...real,
      mode: real.mode,
      createPayoutBatch: async () => {
        throw new PaypalError({ operation: "create payout batch", paypalName: "AUTHORIZATION_ERROR", message: "Payouts not enabled", debugId: "dbg-po", httpStatus: 403 });
      },
    } satisfies PaypalClient;
    await expect(h.ctx.settlement.runPayouts()).rejects.toMatchObject({ code: "paypal_error", debugId: "dbg-po" });
    expect(balanceOf(h.ctx, "channel3")).toEqual({ available: 15_000_000, paidOut: 0 });
    const row = stmt(h.ctx.db, "SELECT status, error FROM payouts").get() as { status: string; error: string };
    expect(row.status).toBe("failed");
    expect(row.error).toContain("dbg-po");
    expect(stmt(h.ctx.db, "SELECT status FROM payout_items").get()).toEqual({ status: "DENIED" });
  });

  it("restores only the items PayPal could not deliver (partial)", async () => {
    const h = createHarness();
    stmt(h.ctx.db, "UPDATE sellers SET paypal_email = 'not-an-email' WHERE id = 'reviews'").run();
    setBalance(h.ctx, "channel3", 11_000_000);
    setBalance(h.ctx, "reviews", 13_000_000);
    const payout = await h.ctx.settlement.runPayouts();
    expect(payout?.status).toBe("partial");
    expect(payout?.items.find((i) => i.sellerId === "reviews")?.status).toBe("FAILED");
    expect(balanceOf(h.ctx, "reviews")).toEqual({ available: 13_000_000, paidOut: 0 });
    expect(balanceOf(h.ctx, "channel3")).toEqual({ available: 0, paidOut: 1_075 * MICROS_PER_CENT });
  });

  it("pays out what a settled tab credited", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 4_000, 5_000); // $20
    addVouchers(h.ctx, tabId, "pricewatch", 500, 10_000); // $5
    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    const net = Object.fromEntries(settlement.lines.map((l) => [l.sellerId, l.netMicros]));

    const payout = await h.ctx.settlement.runPayouts();
    const expected = Math.floor(net.channel3! / MICROS_PER_CENT) - 25;
    expect(payout?.items).toEqual([expect.objectContaining({ sellerId: "channel3", amountCents: expected })]);
    expect(balanceOf(h.ctx, "channel3").available).toBe(net.channel3! - (expected + 25) * MICROS_PER_CENT);
    expect(balanceOf(h.ctx, "pricewatch").available).toBe(net.pricewatch);
  });
});
