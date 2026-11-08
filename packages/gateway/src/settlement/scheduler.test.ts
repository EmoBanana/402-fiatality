import { MICROS_PER_CENT } from "@p402/shared";
import { describe, expect, it } from "vitest";
import { DAY_MS, HOUR_MS } from "../clock";
import type { PaypalClient } from "../context";
import { kvGet, stmt } from "../db/db";
import type { TabRow } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import { inspectMockAuthorization } from "../paypal/mock";
import { addVouchers, createHarness, openTab, T0 } from "./testing";

const tabRow = (h: ReturnType<typeof createHarness>, id: string) => stmt(h.ctx.db, "SELECT * FROM tabs WHERE id = ?").get(id) as TabRow;
const dollars = (h: ReturnType<typeof createHarness>, tabId: string, amount: number, sellerId = "channel3") =>
  addVouchers(h.ctx, tabId, sellerId, amount, MICROS_PER_CENT * 100); // $1.00 per call

describe("settlement.tick", () => {
  it("does nothing before anything is due", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 20);
    h.advance(3 * DAY_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId)).toMatchObject({ status: "active", reauthorized_at: null });
    expect(h.calls.reauthorize ?? 0).toBe(0);
  });

  it("reauthorizes on day 4 (new honor window) and charges on day 7", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 20);

    h.advance(4 * DAY_MS);
    await h.ctx.settlement.tick();
    const reauthorized = tabRow(h, tabId);
    expect(reauthorized).toMatchObject({
      status: "active",
      reauthorized_at: T0 + 4 * DAY_MS,
      honor_until: T0 + 7 * DAY_MS,
      expires_at: T0 + 29 * DAY_MS,
      close_at: T0 + 7 * DAY_MS,
    });
    expect(reauthorized.reauth_authorization_id).toMatch(/^MOCK-AUTH-/);
    await h.ctx.settlement.tick();
    expect(h.calls.reauthorize).toBe(1);

    h.advance(3 * DAY_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
    expect(inspectMockAuthorization(h.ctx.db, reauthorized.reauth_authorization_id!)).toMatchObject({ status: "CAPTURED", capturedCents: 2_000 });
  });

  it("small tab: skips the day-4 reauthorization, reauthorizes on day 25 and charges by day 28", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 3); // below the $10 smallTabMinCents

    h.advance(4 * DAY_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId)).toMatchObject({
      status: "active",
      reauthorized_at: null,
      reauthorize_at: T0 + 25 * DAY_MS,
      close_at: T0 + 28 * DAY_MS,
    });
    expect(h.calls.reauthorize ?? 0).toBe(0);

    h.advance(4 * DAY_MS); // day 8: the old day-7 charge no longer applies
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("active");

    h.advance(17 * DAY_MS); // day 25
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId)).toMatchObject({ status: "active", reauthorized_at: T0 + 25 * DAY_MS });
    expect(h.calls.reauthorize).toBe(1);

    h.advance(3 * DAY_MS); // day 28
    await h.ctx.settlement.tick();
    const settled = tabRow(h, tabId);
    expect(settled.status).toBe("settled");
    const settlement = stmt(h.ctx.db, "SELECT charged_cents FROM settlements WHERE tab_id = ?").get(tabId);
    expect(settlement).toEqual({ charged_cents: 300 });
  });

  it("a small tab that grows past the minimum before day 4 takes the normal path", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 12);
    h.advance(4 * DAY_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId)).toMatchObject({ reauthorized_at: T0 + 4 * DAY_MS, close_at: T0 + 7 * DAY_MS });
  });

  it("closes as soon as billable reaches closeAtCents ($50)", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 49);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("active");
    addVouchers(h.ctx, tabId, "pricewatch", 100, 10_000); // + $1.00
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
    const settlement = stmt(h.ctx.db, "SELECT charged_cents, paypal_fee_cents FROM settlements WHERE tab_id = ?").get(tabId);
    expect(settlement).toEqual({ charged_cents: 5_000, paypal_fee_cents: 224 });
  });

  it("charges a paused or frozen tab on schedule", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 15);
    stmt(h.ctx.db, "UPDATE tabs SET status = 'frozen' WHERE id = ?").run(tabId);
    h.advance(7 * DAY_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
    // The charge was due anyway, so no pointless reauthorization first.
    expect(h.calls.reauthorize ?? 0).toBe(0);
  });

  it("small-tab deferral and a big clock jump settle in one tick when everything is due", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 2);
    h.advance(28 * DAY_MS + HOUR_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
  });

  it("closes before the authorization expires (safety)", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 2);
    stmt(h.ctx.db, "UPDATE tabs SET close_at = NULL, reauthorize_at = NULL WHERE id = ?").run(tabId);
    h.advance(29 * DAY_MS - 2 * HOUR_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("active");
    h.advance(HOUR_MS);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
  });

  it("keeps the original authorization when PayPal refuses the reauthorization (sandbox honor window)", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 20);
    const real = h.ctx.paypal;
    let refusals = 0;
    h.ctx.paypal = {
      ...real,
      mode: real.mode,
      reauthorize: async () => {
        refusals++;
        throw new PaypalError({ operation: "reauthorize", paypalName: "UNPROCESSABLE_ENTITY", message: "", debugId: "dbg", issues: [{ issue: "REAUTHORIZATION_TOO_SOON" }], httpStatus: 422 });
      },
    } satisfies PaypalClient;

    h.advance(4 * DAY_MS);
    await h.ctx.settlement.tick();
    await h.ctx.settlement.tick();
    expect(refusals).toBe(1);
    expect(tabRow(h, tabId)).toMatchObject({ status: "active", reauthorized_at: null, reauth_authorization_id: null });
    expect(kvGet(h.ctx.db, `settlement:reauth-failed:${tabId}`)).not.toBeNull();

    h.advance(3 * DAY_MS);
    await h.ctx.settlement.tick();
    const tab = tabRow(h, tabId);
    expect(tab.status).toBe("settled");
    expect(inspectMockAuthorization(h.ctx.db, tab.authorization_id!)).toMatchObject({ status: "CAPTURED", capturedCents: 2_000 });
  });

  it("sandbox: doesn't ask PayPal to reauthorize while its real honor window is open", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx, { closeAfterDays: 20 });
    dollars(h, tabId, 20);
    h.ctx.paypal = { ...h.ctx.paypal, mode: "sandbox" };

    h.ctx.clock.advance(4 * DAY_MS); // demo fast-forward: real time has not moved
    await h.ctx.settlement.tick();
    expect(h.calls.reauthorize ?? 0).toBe(0);
    expect(tabRow(h, tabId)).toMatchObject({ status: "active", reauthorized_at: null, reauthorize_at: T0 + 4 * DAY_MS });

    h.advance(3 * DAY_MS); // real time catches up past PayPal's honor window
    await h.ctx.settlement.tick();
    expect(h.calls.reauthorize).toBe(1);
    expect(tabRow(h, tabId).reauthorized_at).toBe(T0 + 7 * DAY_MS);
  });

  it("resumes a tab a crash left in `closing`", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 5);
    stmt(h.ctx.db, "UPDATE tabs SET status = 'closing' WHERE id = ?").run(tabId);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("settled");
  });

  it("leaves failed tabs alone (a human retries the close)", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    dollars(h, tabId, 60);
    stmt(h.ctx.db, "UPDATE tabs SET status = 'failed' WHERE id = ?").run(tabId);
    await h.ctx.settlement.tick();
    expect(tabRow(h, tabId).status).toBe("failed");
    expect(h.calls.captureAuthorization ?? 0).toBe(0);
  });
});
