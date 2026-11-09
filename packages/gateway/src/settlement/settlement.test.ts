import { createHash } from "node:crypto";
import { captureFeeCents, MICROS_PER_CENT, naiveFeeCents, normalizePolicy, type SettlementDTO } from "@p402/shared";
import { describe, expect, it } from "vitest";
import { DAY_MS } from "../clock";
import { AppError, type PaypalClient } from "../context";
import { stmt } from "../db/db";
import type { TabRow } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import { finalizeVoucher } from "../paywall/ledger";
import { approveMockOrder, getMockOrder, inspectMockAuthorization } from "../paypal/mock";
import { cancelApproval, completeApproval } from "./approvals";
import { pendingCarry } from "./store";
import { addVouchers, balanceOf, COMPANY_ID, createHarness, openTab, T0 } from "./testing";

const tabRow = (h: ReturnType<typeof createHarness>, id: string) => stmt(h.ctx.db, "SELECT * FROM tabs WHERE id = ?").get(id) as TabRow;

function expectLedgerInvariant(settlement: SettlementDTO) {
  const net = settlement.lines.reduce((s, l) => s + l.netMicros, 0);
  const fees = settlement.lines.reduce((s, l) => s + l.feeShareMicros, 0);
  expect(net + fees).toBe(settlement.chargedCents * MICROS_PER_CENT);
  for (const line of settlement.lines) expect(line.netMicros).toBe(line.grossMicros - line.feeShareMicros);
}

describe("createHold", () => {
  it("stores a pending tab with a hashed enroll token and an AUTHORIZE order", async () => {
    const h = createHarness();
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, label: "Espresso research", policy: normalizePolicy({ holdCents: 5_000 }) });

    expect(created.enrollToken).toMatch(/^tok_[A-Za-z0-9_-]{43}$/);
    expect(created.tab).toMatchObject({ status: "pending_approval", holdCents: 5_000, label: "Espresso research", carryInMicros: 0 });
    expect(created.tab.paypal).toMatchObject({ orderId: created.orderId, approveUrl: created.approveUrl });
    expect(created.approveUrl).toBe(`http://localhost:4020/paypal/mock/approve?token=${created.orderId}`);
    const row = tabRow(h, created.tab.id);
    expect(row.enroll_token_hash).toBe(createHash("sha256").update(created.enrollToken).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(created.enrollToken);

    const order = getMockOrder(h.ctx.db, created.orderId);
    expect(order).toMatchObject({
      intent: "AUTHORIZE",
      amountCents: 5_000,
      referenceId: created.tab.id,
      description: "Agent spending tab",
      brandName: "402 Fiatality",
      returnUrl: `http://localhost:4020/paypal/return?kind=tab&ref=${created.tab.id}`,
      cancelUrl: `http://localhost:4020/paypal/cancel?kind=tab&ref=${created.tab.id}`,
    });
    expect(h.events.filter((e) => e.type === "tab.updated").map((e) => e.data.id)).toEqual([created.tab.id]);
  });

  it("rejects unknown companies and keeps one open tab per company", async () => {
    const h = createHarness();
    await expect(h.ctx.settlement.createHold({ companyId: "co_nope", policy: normalizePolicy() })).rejects.toMatchObject({ status: 404 });

    const abandoned = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });
    const { tabId } = await openTab(h.ctx);
    expect(tabRow(h, abandoned.tab.id).status).toBe("cancelled");
    await expect(h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() })).rejects.toMatchObject({
      status: 409,
      code: "tab_already_open",
      details: { tabId },
    });
  });
});

describe("PayPal return and cancel", () => {
  it("authorizes the hold and sets the schedule, idempotently", async () => {
    const h = createHarness();
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy({ closeAfterDays: 7 }) });
    approveMockOrder(h.ctx.db, created.orderId);

    const [first, second] = await Promise.all([
      completeApproval(h.ctx, "tab", created.tab.id, created.orderId),
      completeApproval(h.ctx, "tab", created.tab.id, created.orderId),
    ]);
    const third = await completeApproval(h.ctx, "tab", created.tab.id, created.orderId);
    for (const message of [first, second, third]) {
      expect(message).toEqual({ type: "p402:paypal-return", kind: "tab", ref: created.tab.id, status: "approved" });
    }
    expect(h.calls.authorizeOrder).toBe(1);

    const row = tabRow(h, created.tab.id);
    expect(row).toMatchObject({
      status: "active",
      authorized_at: T0,
      honor_until: T0 + 3 * DAY_MS,
      reauthorize_at: T0 + 4 * DAY_MS,
      close_at: T0 + 7 * DAY_MS,
      expires_at: T0 + 29 * DAY_MS,
    });
    expect(row.authorization_id).toMatch(/^MOCK-AUTH-/);
  });

  it("refuses a token that belongs to another order and reports PayPal failures", async () => {
    const h = createHarness();
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });
    expect(await completeApproval(h.ctx, "tab", created.tab.id, "MOCK-ORDER-OTHER")).toMatchObject({ status: "failed" });
    // Not approved on (mock) PayPal yet: authorization fails, the tab stays pending so the payer can retry.
    const failed = await completeApproval(h.ctx, "tab", created.tab.id, created.orderId);
    expect(failed.status).toBe("failed");
    expect(failed.message).toContain("ORDER_NOT_APPROVED");
    expect(tabRow(h, created.tab.id).status).toBe("pending_approval");
    expect(await completeApproval(h.ctx, "tab", "tab_missing", created.orderId)).toMatchObject({ status: "failed" });
  });

  it("cancels an unapproved tab and gives its carry-in back", async () => {
    const h = createHarness();
    stmt(h.ctx.db, "INSERT INTO kv (key, value) VALUES (?, '4000')").run(`carry:${COMPANY_ID}`);
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });
    expect(created.tab.carryInMicros).toBe(4_000);
    expect(pendingCarry(h.ctx.db, COMPANY_ID)).toBe(0);

    expect(await cancelApproval(h.ctx, "tab", created.tab.id, created.orderId)).toMatchObject({ status: "cancelled" });
    expect(await cancelApproval(h.ctx, "tab", created.tab.id, created.orderId)).toMatchObject({ status: "cancelled" });
    expect(tabRow(h, created.tab.id)).toMatchObject({ status: "cancelled", carry_in_micros: 0 });
    expect(pendingCarry(h.ctx.db, COMPANY_ID)).toBe(4_000);
    // A late approval of a cancelled tab authorizes nothing.
    approveMockOrder(h.ctx.db, created.orderId);
    expect(await completeApproval(h.ctx, "tab", created.tab.id, created.orderId)).toMatchObject({ status: "cancelled" });
    expect(h.calls.authorizeOrder ?? 0).toBe(0);
  });
});

describe("closeTab", () => {
  it("captures once, splits the fee pro rata and credits sellers (SPEC §6.4)", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 600, 5_000); // $3.00
    addVouchers(h.ctx, tabId, "pricewatch", 100, 10_000); // $1.00
    addVouchers(h.ctx, tabId, "reviews", 101, 3_000); // $0.303
    const voided = addVouchers(h.ctx, tabId, "reviews", 7, 3_000, { status: "voided", voidReason: "upstream_5xx" });
    addVouchers(h.ctx, tabId, "reviews", 2, 3_000, { status: "voided", voidReason: "empty_result" });

    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    // $4.303 billable -> $4.30 charged, $0.003 carried.
    expect(settlement).toMatchObject({
      status: "completed",
      billableMicros: 4_303_000,
      chargedCents: 430,
      carryOutMicros: 3_000,
      paypalFeeCents: captureFeeCents(430),
      naiveFeeCents: naiveFeeCents(801, 4_303_000),
      callCount: 801,
      voidCount: 9,
      voidedMicros: 27_000,
    });
    expect(settlement.captureId).toMatch(/^MOCK-CAPTURE-/);
    expectLedgerInvariant(settlement);
    expect(settlement.lines.map((l) => [l.sellerId, l.calls])).toEqual([
      ["channel3", 600],
      ["pricewatch", 100],
      ["reviews", 101],
    ]);
    expect(settlement.lines[0]?.sellerName).toBe("Channel3");

    for (const line of settlement.lines) expect(balanceOf(h.ctx, line.sellerId).available).toBe(line.netMicros);
    const unsettled = stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM vouchers WHERE tab_id = ? AND status = 'accepted' AND settlement_id IS NULL").get(tabId) as { n: number };
    expect(unsettled.n).toBe(0);
    const voidedRow = stmt(h.ctx.db, "SELECT settlement_id FROM vouchers WHERE id = ?").get(voided[0]) as { settlement_id: string | null };
    expect(voidedRow.settlement_id).toBeNull();

    const tab = tabRow(h, tabId);
    expect(tab).toMatchObject({ status: "settled", closed_at: T0 });
    const auth = inspectMockAuthorization(h.ctx.db, tab.authorization_id!);
    expect(auth).toMatchObject({ status: "CAPTURED", capturedCents: 430, releasedCents: 5_000 - 430 });
    expect(pendingCarry(h.ctx.db, COMPANY_ID)).toBe(3_000);

    const types = h.events.map((e) => e.type);
    expect(types).toContain("settlement.completed");
    expect(h.events.filter((e) => e.type === "seller.updated")).toHaveLength(3);
    const lastTab = h.events.filter((e) => e.type === "tab.updated").at(-1);
    expect(lastTab?.data).toMatchObject({ id: tabId, status: "settled" });
  });

  it("is idempotent: concurrent and repeated closes return the same settlement and capture once", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 300, 5_000);
    const [a, b] = await Promise.all([h.ctx.settlement.closeTab(tabId, "manual"), h.ctx.settlement.closeTab(tabId, "threshold")]);
    const c = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(h.calls.captureAuthorization).toBe(1);
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 1 });
    expect(balanceOf(h.ctx, "channel3").available).toBe(a.lines[0]!.netMicros);
  });

  it("carries the sub-cent remainder into the company's next tab", async () => {
    const h = createHarness();
    const first = await openTab(h.ctx);
    addVouchers(h.ctx, first.tabId, "channel3", 5, 5_000); // 2.5 cents
    const s1 = await h.ctx.settlement.closeTab(first.tabId, "manual");
    expect(s1).toMatchObject({ chargedCents: 2, carryOutMicros: 5_000 });
    expectLedgerInvariant(s1);

    const second = await openTab(h.ctx);
    expect(tabRow(h, second.tabId).carry_in_micros).toBe(5_000);
    expect(pendingCarry(h.ctx.db, COMPANY_ID)).toBe(0);
    addVouchers(h.ctx, second.tabId, "pricewatch", 1, 10_000); // 1 cent + 0.5 carried = 1.5 cents
    addVouchers(h.ctx, second.tabId, "channel3", 1, 5_000); // + 0.5 = 2 cents
    const s2 = await h.ctx.settlement.closeTab(second.tabId, "manual");
    expect(s2).toMatchObject({ billableMicros: 20_000, chargedCents: 2, carryOutMicros: 0 });
    expectLedgerInvariant(s2);
    // Over both tabs the buyer paid exactly what the sellers earned: 25,000 + 15,000 µ = 4 cents.
    expect(s1.chargedCents + s2.chargedCents).toBe(4);
    const credited = balanceOf(h.ctx, "channel3").available + balanceOf(h.ctx, "pricewatch").available;
    const fees = (s1.paypalFeeCents + s2.paypalFeeCents) * MICROS_PER_CENT;
    expect(credited + fees).toBe(4 * MICROS_PER_CENT);
  });

  it("voids the hold when the charge floors to $0 and carries everything", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 1, 5_000);
    addVouchers(h.ctx, tabId, "reviews", 3, 3_000, { status: "voided" });

    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(settlement).toMatchObject({
      status: "completed",
      chargedCents: 0,
      paypalFeeCents: 0,
      captureId: null,
      carryOutMicros: 5_000,
      voidCount: 3,
    });
    expect(settlement.lines).toEqual([
      { sellerId: "channel3", sellerName: "Channel3", grossMicros: 0, feeShareMicros: 0, netMicros: 0, calls: 1 },
    ]);
    expectLedgerInvariant(settlement);
    expect(h.calls.captureAuthorization ?? 0).toBe(0);
    expect(inspectMockAuthorization(h.ctx.db, tabRow(h, tabId).authorization_id!)).toMatchObject({ status: "VOIDED", releasedCents: 5_000 });
    expect(pendingCarry(h.ctx.db, COMPANY_ID)).toBe(5_000);
    expect(balanceOf(h.ctx, "channel3").available).toBe(0);
  });

  it("marks the tab failed on a PayPal error, keeps vouchers unsettled and succeeds on retry", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 200, 5_000);
    const real = h.ctx.paypal;
    h.ctx.paypal = {
      ...real,
      mode: real.mode,
      captureAuthorization: async () => {
        throw new PaypalError({ operation: "capture authorization", paypalName: "UNPROCESSABLE_ENTITY", message: "", debugId: "dbg-1", issues: [{ issue: "INSTRUMENT_DECLINED" }], httpStatus: 422 });
      },
    } satisfies PaypalClient;

    const err = await h.ctx.settlement.closeTab(tabId, "manual").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect((err as PaypalError).details).toMatchObject({ debug_id: "dbg-1" });
    expect(tabRow(h, tabId).status).toBe("failed");
    const failed = stmt(h.ctx.db, "SELECT status, error FROM settlements WHERE tab_id = ?").get(tabId) as { status: string; error: string };
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("INSTRUMENT_DECLINED");
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM vouchers WHERE settlement_id IS NOT NULL").get()).toEqual({ n: 0 });
    expect(balanceOf(h.ctx, "channel3").available).toBe(0);

    h.ctx.paypal = real;
    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(settlement).toMatchObject({ status: "completed", chargedCents: 100 });
    expectLedgerInvariant(settlement);
    expect(tabRow(h, tabId).status).toBe("settled");
  });

  it("captures on the reauthorization once there is one", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 2_400, 5_000); // $12
    h.advance(4 * DAY_MS);
    await h.ctx.settlement.tick();
    const tab = tabRow(h, tabId);
    expect(tab.reauth_authorization_id).toMatch(/^MOCK-AUTH-/);
    await h.ctx.settlement.closeTab(tabId, "manual");
    expect(inspectMockAuthorization(h.ctx.db, tab.reauth_authorization_id!)).toMatchObject({ status: "CAPTURED", capturedCents: 1_200 });
    expect(inspectMockAuthorization(h.ctx.db, tab.authorization_id!)).toMatchObject({ capturedCents: 0 });
  });

  it("waits for calls still in flight so their charge is not lost", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 10, 5_000);
    const [inFlight] = addVouchers(h.ctx, tabId, "channel3", 1, 5_000, { status: "pending" });
    setTimeout(() => stmt(h.ctx.db, "UPDATE vouchers SET status = 'accepted' WHERE id = ?").run(inFlight), 150);
    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(settlement).toMatchObject({ callCount: 11, billableMicros: 55_000, chargedCents: 5, carryOutMicros: 5_000 });
  });

  it("waits out the seller's own timeout, then voids a call still in flight so a late answer is never unbilled spend", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    stmt(h.ctx.db, "UPDATE sellers SET void_rules = ? WHERE id = 'channel3'").run(JSON.stringify({ timeoutMs: 250 }));
    addVouchers(h.ctx, tabId, "channel3", 10, 5_000);
    const [late] = addVouchers(h.ctx, tabId, "channel3", 1, 5_000, { status: "pending" });
    const started = Date.now();
    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    const waitedMs = Date.now() - started;

    // The seller answers after the charge: the paywall's verdict must not turn the call into accepted, unbilled spend.
    const dto = finalizeVoucher(h.ctx, late!, { status: "accepted", voidReason: null, httpStatus: 200, latencyMs: 9_000, responseBytes: 2, responseExcerpt: "{}" });
    expect(dto).toMatchObject({ status: "voided", voidReason: "timeout" });
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM vouchers WHERE tab_id = ? AND status = 'accepted' AND settlement_id IS NULL").get(tabId)).toEqual({ n: 0 });
    expect(settlement).toMatchObject({ callCount: 10, billableMicros: 50_000, chargedCents: 5, voidCount: 1 });
    expect(waitedMs).toBeLessThan(5_000); // the seller's 250 ms timeout plus grace, not a fixed wait
  });

  it("resumes a settlement a crash left pending, with the same PayPal-Request-Id", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 400, 5_000);
    // State after a crash between claiming the vouchers and the PayPal capture.
    stmt(
      h.ctx.db,
      `INSERT INTO settlements (id, tab_id, status, billable_micros, charged_cents, carry_out_micros, naive_fee_cents, call_count, created_at)
       VALUES ('stl_crashed', ?, 'pending', 2000000, 200, 0, 0, 400, ?)`,
    ).run(tabId, T0);
    stmt(h.ctx.db, "UPDATE vouchers SET settlement_id = 'stl_crashed' WHERE tab_id = ?").run(tabId);
    stmt(h.ctx.db, "UPDATE tabs SET status = 'closing' WHERE id = ?").run(tabId);

    const settlement = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(settlement).toMatchObject({ id: "stl_crashed", status: "completed", chargedCents: 200 });
    expectLedgerInvariant(settlement);
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM settlements").get()).toEqual({ n: 1 });
  });

  it("refuses tabs that were never authorized", async () => {
    const h = createHarness();
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });
    await expect(h.ctx.settlement.closeTab(created.tab.id, "manual")).rejects.toMatchObject({ status: 409, code: "tab_not_authorized" });
    await expect(h.ctx.settlement.closeTab("tab_missing", "manual")).rejects.toBeInstanceOf(AppError);
  });
});

describe("purchases", () => {
  it("proposes, checks out, captures on return and stays idempotent", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    const proposed = await h.ctx.settlement.proposePurchase({
      tabId,
      title: "Breville Barista Express",
      amountCents: 14_900,
      merchant: "Example Coffee Co",
      productUrl: "https://example.com/p/1",
      researchCostMicros: 370_000,
      reasoning: "Best value under $150",
    });
    expect(proposed).toMatchObject({ status: "proposed", amountCents: 14_900, researchCostMicros: 370_000, tabId });

    const checkout = await h.ctx.settlement.checkoutPurchase(proposed.id);
    expect(checkout.purchase.status).toBe("awaiting_approval");
    expect(checkout.approveUrl).toContain("/paypal/mock/approve?token=");
    expect((await h.ctx.settlement.checkoutPurchase(proposed.id)).approveUrl).toBe(checkout.approveUrl);
    const orderId = checkout.purchase.paypalOrderId!;
    expect(getMockOrder(h.ctx.db, orderId)).toMatchObject({
      intent: "CAPTURE",
      itemName: "Breville Barista Express",
      returnUrl: `http://localhost:4020/paypal/return?kind=purchase&ref=${proposed.id}`,
    });

    expect(await cancelApproval(h.ctx, "purchase", proposed.id, orderId)).toMatchObject({ status: "cancelled" });
    const again = await h.ctx.settlement.checkoutPurchase(proposed.id);
    expect(again.purchase.paypalOrderId).toBe(orderId);

    approveMockOrder(h.ctx.db, orderId);
    expect(await completeApproval(h.ctx, "purchase", proposed.id, orderId)).toMatchObject({ kind: "purchase", status: "approved" });
    expect(await completeApproval(h.ctx, "purchase", proposed.id, orderId)).toMatchObject({ status: "approved" });
    expect(h.calls.captureOrder).toBe(1);
    const row = stmt(h.ctx.db, "SELECT status, capture_id FROM purchases WHERE id = ?").get(proposed.id) as { status: string; capture_id: string };
    expect(row.status).toBe("captured");
    expect(row.capture_id).toMatch(/^MOCK-CAPTURE-/);
    await expect(h.ctx.settlement.checkoutPurchase(proposed.id)).rejects.toMatchObject({ status: 409, code: "purchase_captured" });
    expect(h.events.filter((e) => e.type === "purchase.updated").at(-1)?.data).toMatchObject({ id: proposed.id, status: "captured" });
  });

  it("rejects purchases for unknown tabs", async () => {
    const h = createHarness();
    await expect(
      h.ctx.settlement.proposePurchase({ tabId: "tab_missing", title: "x", amountCents: 100, researchCostMicros: 0 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("statement", () => {
  it("previews an open tab and reports the final settlement once closed", async () => {
    const h = createHarness();
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 1_000, 5_000); // $5
    addVouchers(h.ctx, tabId, "reviews", 4, 3_000, { status: "voided", voidReason: "malformed_json" });

    const preview = await h.ctx.settlement.statement(tabId);
    expect(preview.settlement).toBeNull();
    expect(preview.company).toMatchObject({ id: COMPANY_ID, name: "Northwind Research" });
    expect(preview.sellers).toEqual([
      expect.objectContaining({ sellerId: "channel3", sellerName: "Channel3", grossMicros: 5_000_000, calls: 1_000 }),
    ]);
    expect(preview.fees.paypalFeeCents).toBe(captureFeeCents(500));
    expect(preview.voids).toEqual({ count: 4, micros: 12_000, byReason: { malformed_json: 4 } });

    await h.ctx.settlement.closeTab(tabId, "manual");
    const final = await h.ctx.settlement.statement(tabId);
    expect(final.settlement?.status).toBe("completed");
    expect(final.tab.status).toBe("settled");
    expect(final.sellers).toEqual(final.settlement?.lines);
    const fee = captureFeeCents(500);
    const naive = naiveFeeCents(1_000, 5_000_000);
    expect(final.fees).toEqual({
      paypalFeeCents: fee,
      effectiveRatePct: Math.round((fee / 500) * 10_000) / 100,
      naiveFeeCents: naive,
      savedCents: naive - fee,
    });
  });
});
