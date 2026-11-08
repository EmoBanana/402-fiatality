import { DEFAULT_POLICY, normalizePolicy, type AlarmDTO, type GatewayEvent, type ReviewDTO, type TabDetailDTO } from "@p402/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  detectBudgetThreshold,
  detectErrorStreak,
  detectRepeatRequest,
  detectSpendSpike,
  detectVelocity,
  lastPausingAlarmAt,
} from "../src/alarms/detectors";
import { createTestContext, type AppContext } from "../src/context";
import { createHarness, injectJson, openTab, sleep, type Harness } from "./helpers";

const MIN = 60_000;

describe("detectors", () => {
  const T0 = 100 * MIN;
  function seed(): AppContext {
    const ctx = createTestContext({ realNow: () => T0 });
    const db = ctx.db;
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('co', 'Co', 0)").run();
    db.prepare("INSERT INTO sellers (id, name, base_url, paypal_email, void_rules, created_at) VALUES ('s', 'S', 'https://s.example', 'e@x.co', '{}', 0)").run();
    db.prepare("INSERT INTO tabs (id, company_id, status, policy, hold_cents, enroll_token_hash, created_at) VALUES ('t', 'co', 'active', '{}', 5000, 'h', 0)").run();
    return ctx;
  }
  let seq = 0;
  function voucher(ctx: AppContext, at: number, o: { status?: string; price?: number; hash?: string } = {}) {
    seq += 1;
    ctx.db
      .prepare(
        "INSERT INTO vouchers (id, tab_id, seller_id, seq, price_micros, cumulative_micros, req_hash, method, path, status, signature, created_at) VALUES (?, 't', 's', ?, ?, 0, ?, 'GET', '/x', ?, 'sig', ?)",
      )
      .run(`v${seq}`, seq, o.price ?? 1_000, o.hash ?? `h${seq}`, o.status ?? "accepted", at);
  }
  const policy = (alarms: Partial<typeof DEFAULT_POLICY.alarms> = {}, more: Partial<typeof DEFAULT_POLICY> = {}) =>
    normalizePolicy({ ...more, alarms: { ...DEFAULT_POLICY.alarms, ...alarms } });

  it("repeat_request: same hash N times inside the window, counted after the last pausing alarm", () => {
    const ctx = seed();
    for (let i = 0; i < 4; i++) voucher(ctx, T0 - 10_000 + i, { hash: "same" });
    voucher(ctx, T0 - 120_000, { hash: "same" }); // outside the 60 s window
    const p = policy({ repeatRequestThreshold: 5 });
    expect(detectRepeatRequest(ctx.db, "t", p, T0, 0, "same")).toBeNull();
    voucher(ctx, T0, { hash: "same" });
    expect(detectRepeatRequest(ctx.db, "t", p, T0, 0, "same")).toMatchObject({ kind: "repeat_request", pause: true, detail: { count: 5 } });
    expect(detectRepeatRequest(ctx.db, "t", p, T0, T0 - 5_000, "same")).toBeNull();
  });

  it("error_streak: the last N judged calls all voided", () => {
    const ctx = seed();
    voucher(ctx, T0 - 4, { status: "accepted" });
    voucher(ctx, T0 - 3, { status: "voided" });
    voucher(ctx, T0 - 2, { status: "voided" });
    const p = policy({ errorStreak: 3 });
    expect(detectErrorStreak(ctx.db, "t", p, 0)).toBeNull();
    voucher(ctx, T0 - 1, { status: "pending" }); // in flight: not judged yet
    voucher(ctx, T0, { status: "voided" });
    expect(detectErrorStreak(ctx.db, "t", p, 0)).toMatchObject({ kind: "error_streak", detail: { streak: 3 } });
    expect(detectErrorStreak(ctx.db, "t", p, T0 - 3)).toBeNull();
  });

  it("velocity: calls in the last minute reach 90% of the rate limit", () => {
    const ctx = seed();
    const p = policy({}, { maxCallsPerMinute: 10 });
    for (let i = 0; i < 8; i++) voucher(ctx, T0 - 30_000 + i);
    voucher(ctx, T0 - 2 * MIN);
    expect(detectVelocity(ctx.db, "t", p, T0, 0)).toBeNull();
    voucher(ctx, T0);
    expect(detectVelocity(ctx.db, "t", p, T0, 0)).toMatchObject({ kind: "velocity", detail: { calls: 9, threshold: 9 } });
  });

  it("spend_spike: needs 3 baseline minutes and $0.05 in the last minute, then compares with the multiplier", () => {
    const ctx = seed();
    const p = policy({ spendSpikeMultiplier: 4 });
    voucher(ctx, T0 - 5 * MIN, { price: 2_000 });
    voucher(ctx, T0 - 4 * MIN, { price: 2_000 });
    for (let i = 0; i < 10; i++) voucher(ctx, T0 - 10_000 + i, { price: 5_000 });
    expect(detectSpendSpike(ctx.db, "t", p, T0, 0)).toBeNull(); // only 2 baseline minutes
    voucher(ctx, T0 - 3 * MIN, { price: 2_000 });
    expect(detectSpendSpike(ctx.db, "t", p, T0, 0)).toMatchObject({ kind: "spend_spike", detail: { lastMinuteMicros: 50_000, averageMicros: 2_000 } });
    expect(detectSpendSpike(ctx.db, "t", policy({ spendSpikeMultiplier: 30 }), T0, 0)).toBeNull();
    voucher(ctx, T0 - 2 * MIN, { price: 60_000 }); // a busy baseline minute raises the average (16,500 x 4 > 50,000)
    expect(detectSpendSpike(ctx.db, "t", p, T0, 0)).toBeNull();
  });

  it("spend_spike ignores small last-minute spend", () => {
    const ctx = seed();
    for (const m of [5, 4, 3]) voucher(ctx, T0 - m * MIN, { price: 100 });
    for (let i = 0; i < 9; i++) voucher(ctx, T0 - i, { price: 5_000 }); // $0.045
    expect(detectSpendSpike(ctx.db, "t", policy(), T0, 0)).toBeNull();
  });

  it("budget_threshold: once per tab, counting accepted spend and carry-in", () => {
    const ctx = seed();
    const p = policy({ budgetWarnPct: 50 });
    const tab = { id: "t", hold_cents: 100, carry_in_micros: 0 };
    voucher(ctx, T0, { price: 400_000 });
    voucher(ctx, T0, { price: 400_000, status: "voided" });
    expect(detectBudgetThreshold(ctx.db, tab, p)).toBeNull();
    expect(detectBudgetThreshold(ctx.db, { ...tab, carry_in_micros: 100_000 }, p)).toMatchObject({ kind: "budget_threshold", pause: false });
    ctx.db.prepare("INSERT INTO alarms (id, tab_id, kind, message, status, created_at) VALUES ('a', 't', 'budget_threshold', 'm', 'open', 1)").run();
    expect(detectBudgetThreshold(ctx.db, { ...tab, carry_in_micros: 900_000 }, p)).toBeNull();
    expect(lastPausingAlarmAt(ctx.db, "t")).toBe(0);
  });
});

describe("pause and AI review", () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  const tabDetail = async (tabId: string) => (await injectJson<TabDetailDTO>(h.app, "GET", `/api/tabs/${tabId}`)).body;
  const search = (agent: Awaited<ReturnType<typeof openTab>>["agent"], query = "espresso") =>
    agent.call(h.app, "acme", "POST", "/v1/search", { body: JSON.stringify({ query }) });

  it("repeat_request pauses the tab, streams the debate and freezes a wasteful agent", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { alarms: { repeatRequestThreshold: 3 } });
    const events: GatewayEvent[] = [];
    h.ctx.bus.subscribe((e) => events.push(e));
    for (let i = 0; i < 3; i++) expect((await search(agent)).status).toBe(200);
    await h.idle();

    const tab = await tabDetail(tabId);
    expect(tab.status).toBe("frozen");
    expect(tab.alarms).toHaveLength(1);
    expect(tab.alarms[0]).toMatchObject({ kind: "repeat_request", status: "resolved", detail: { count: 3 } });
    const review = tab.reviews[0]!;
    expect(review).toMatchObject({ status: "done", verdict: "freeze", fault: "agent", decidedBy: "ai", model: "fake-gemma", alarmId: tab.alarms[0]!.id });
    expect(review.transcript.map((m) => m.role)).toEqual(["prosecutor", "defender", "judge"]);

    const types = events.map((e) => e.type).filter((t) => t !== "voucher.accepted");
    expect(types).toEqual(["tab.updated", "alarm.raised", "review.started", "review.message", "review.message", "review.message", "review.finished", "tab.updated"]);
    expect((events.find((e) => e.type === "tab.updated") as { data: { status: string } }).data.status).toBe("paused");

    const input = h.ai.reviews[0]!;
    expect(input.alarm.kind).toBe("repeat_request");
    expect(input.vouchers).toHaveLength(3);
    expect(input.vouchers[0]!.seq).toBe(1); // oldest first
    expect(input.vouchers[0]!.requestExcerpt).toContain("POST /v1/search");
    expect(input.vouchers[0]!.responseExcerpt).toContain("Espresso");

    expect((await search(agent)).reason).toBe("tab_frozen");
  });

  it("a seller-fault verdict voids only this tab's unsettled vouchers, then resumes", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { alarms: { errorStreak: 3 } });
    const good1 = (await agent.call(h.app, "acme", "GET", "/v1/q/ok")).payment!.transaction;
    const good2 = (await agent.call(h.app, "acme", "GET", "/v1/q/ok2")).payment!.transaction;
    const settled = (await agent.call(h.app, "acme", "GET", "/v1/q/ok3")).payment!.transaction;
    h.ctx.db.prepare("UPDATE vouchers SET settlement_id = 'stl_x' WHERE id = ?").run(settled);
    const other = await openTab(h);
    const foreign = (await other.agent.call(h.app, "acme", "GET", "/v1/q/ok")).payment!.transaction;
    h.ai.script = () => ({ verdict: "void", fault: "seller", confidence: 0.85, reason: "Bad data", voidVoucherIds: [good1, settled, foreign, "vch_nope"] });
    const voided: string[] = [];
    h.ctx.bus.on("voucher.voided", (e) => voided.push(e.data.id));

    for (let i = 0; i < 3; i++) await agent.call(h.app, "acme", "GET", `/v1/q/500?i=${i}`);
    await h.idle();

    const tab = await tabDetail(tabId);
    expect(tab.status).toBe("active");
    expect(tab.reviews[0]).toMatchObject({ verdict: "void", fault: "seller", voidedVoucherIds: [good1] });
    const rows = h.ctx.db.prepare("SELECT id, status, void_reason, review_id FROM vouchers WHERE id IN (?, ?, ?, ?)").all(good1, good2, settled, foreign);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: good1, status: "voided", void_reason: "ai_review", review_id: tab.reviews[0]!.id },
        { id: good2, status: "accepted", void_reason: null, review_id: null },
        { id: settled, status: "accepted", void_reason: null, review_id: null },
        { id: foreign, status: "accepted", void_reason: null, review_id: null },
      ]),
    );
    expect(voided).toContain(good1);
    expect(tab.totals.billableMicros).toBe(2_000);
    // Fresh evidence is needed for the next alarm: the old streak does not re-trigger.
    expect((await agent.call(h.app, "acme", "GET", "/v1/q/500?i=9")).payment?.status).toBe("voided");
    await h.idle();
    expect((await tabDetail(tabId)).status).toBe("active");
  });

  it("escalates low confidence; a human decides, once", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { alarms: { repeatRequestThreshold: 2 } });
    const first = (await search(agent)).payment!.transaction;
    h.ai.script = () => ({ verdict: "void", fault: "seller", confidence: 0.4, reason: "Maybe bad data", voidVoucherIds: [first] });
    await search(agent);
    await h.idle();
    let tab = await tabDetail(tabId);
    expect(tab.status).toBe("paused");
    expect(tab.reviews[0]).toMatchObject({ status: "done", verdict: "escalate", confidence: 0.4, voidedVoucherIds: [] });
    expect(tab.alarms[0]!.status).toBe("open");
    expect((await search(agent)).reason).toBe("tab_paused");

    const decided = await injectJson<ReviewDTO>(h.app, "POST", `/api/reviews/${tab.reviews[0]!.id}/decide`, { verdict: "void" });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ verdict: "void", decidedBy: "human", fault: "seller", voidedVoucherIds: [first] });
    tab = await tabDetail(tabId);
    expect(tab.status).toBe("active");
    expect(tab.alarms[0]!.status).toBe("resolved");
    const again = await injectJson(h.app, "POST", `/api/reviews/${tab.reviews[0]!.id}/decide`, { verdict: "freeze" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "review_decided" });
  });

  it("escalates when the AI fails or times out", async () => {
    h = await createHarness({ reviewTimeoutMs: 150 });
    const one = await openTab(h, { alarms: { repeatRequestThreshold: 2 } });
    h.ai.script = () => {
      throw new Error("model crashed");
    };
    await search(one.agent);
    await search(one.agent);
    await h.idle();
    expect((await tabDetail(one.tabId)).reviews[0]).toMatchObject({ status: "failed", verdict: "escalate" });
    expect((await tabDetail(one.tabId)).reviews[0]!.reason).toMatch(/model crashed/);

    const two = await openTab(h, { alarms: { repeatRequestThreshold: 2 } });
    h.ai.script = () => new Promise(() => {});
    await search(two.agent);
    await search(two.agent);
    await sleep(20);
    expect((await search(two.agent)).required?.accepts[0]?.extra.retryAfterSec).toBe(5); // review running
    await h.idle();
    const tab = await tabDetail(two.tabId);
    expect(tab.status).toBe("paused");
    expect(tab.reviews[0]).toMatchObject({ status: "failed", verdict: "escalate" });
    expect(tab.reviews[0]!.reason).toMatch(/No verdict within/);
    expect((await search(two.agent)).required?.accepts[0]?.extra.retryAfterSec).toBe(30); // waiting for a human
  });

  it("a human can resume a tab mid-review; the AI's late verdict is ignored", async () => {
    h = await createHarness({ reviewTimeoutMs: 5_000 });
    const { tabId, agent } = await openTab(h, { alarms: { repeatRequestThreshold: 2 } });
    let release!: () => void;
    h.ai.script = () => new Promise((resolve) => (release = () => resolve({ verdict: "freeze", fault: "agent", confidence: 0.99 })));
    await search(agent);
    await search(agent);
    await sleep(20);
    expect((await tabDetail(tabId)).reviews[0]!.status).toBe("running");
    const resumed = await injectJson<{ status: string }>(h.app, "POST", `/api/tabs/${tabId}/resume`);
    expect(resumed.body.status).toBe("active");
    release();
    await h.idle();
    const tab = await tabDetail(tabId);
    expect(tab.status).toBe("active");
    expect(tab.reviews[0]).toMatchObject({ verdict: "resume", decidedBy: "human" });
  });

  it("velocity pauses at 90% of the rate limit; an AI resume lets the agent continue", async () => {
    h = await createHarness();
    h.ai.script = () => ({ verdict: "resume", fault: "none", confidence: 0.8, reason: "Legitimate burst" });
    const { tabId, agent } = await openTab(h, { maxCallsPerMinute: 5 });
    for (let i = 0; i < 5; i++) expect((await agent.call(h.app, "acme", "GET", `/v1/q/ok${i}`)).status).toBe(200);
    await h.idle();
    const tab = await tabDetail(tabId);
    expect(tab.alarms.map((a) => a.kind)).toEqual(["velocity"]);
    expect(tab.status).toBe("active");
    expect((await agent.call(h.app, "acme", "GET", "/v1/q/ok9")).reason).toBe("rate_limited");
  });

  it("spend_spike pauses a sudden burst after a steady baseline", async () => {
    let now = 1_000 * MIN;
    h = await createHarness({ realNow: () => now });
    const { tabId, agent } = await openTab(h);
    for (let m = 0; m < 3; m++) {
      expect((await agent.call(h.app, "acme", "GET", `/v1/q/base${m}`)).status).toBe(200);
      now += MIN;
    }
    now += 30_000;
    for (let i = 0; i < 10; i++) expect((await search(agent, `burst ${i}`)).status).toBe(200);
    await h.idle();
    const tab = await tabDetail(tabId);
    expect(tab.alarms.map((a: AlarmDTO) => a.kind)).toEqual(["spend_spike"]);
    expect(tab.status).toBe("frozen");
  });

  it("budget_threshold notifies once and does not pause", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { holdCents: 100, alarms: { budgetWarnPct: 10 } });
    h.ctx.db.prepare("UPDATE tabs SET carry_in_micros = 95000 WHERE id = ?").run(tabId);
    await search(agent, "a");
    await search(agent, "b");
    await h.idle();
    const tab = await tabDetail(tabId);
    expect(tab.status).toBe("active");
    expect(tab.alarms).toHaveLength(1);
    expect(tab.alarms[0]).toMatchObject({ kind: "budget_threshold", status: "open" });
    expect(tab.reviews).toHaveLength(0);
  });

  it("closes the tab (one PayPal charge) once billable spend reaches closeAtCents", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { holdCents: 100 });
    h.ctx.db.prepare("UPDATE tabs SET carry_in_micros = 990000 WHERE id = ?").run(tabId);
    await search(agent, "a");
    await h.idle();
    expect(h.settlement.closed).toEqual([]);
    await search(agent, "b");
    await h.idle();
    expect(h.settlement.closed).toEqual([{ tabId, reason: "threshold" }]);
    expect((await search(agent, "c")).reason).toBe("tab_not_active");
  });

  it("human resume/freeze endpoints follow the allowed transitions", async () => {
    h = await createHarness();
    const { tabId } = await openTab(h);
    expect((await injectJson<{ status: string }>(h.app, "POST", `/api/tabs/${tabId}/freeze`)).body.status).toBe("frozen");
    expect((await injectJson<{ status: string }>(h.app, "POST", `/api/tabs/${tabId}/resume`)).body.status).toBe("active");
    expect((await injectJson<{ status: string }>(h.app, "POST", `/api/tabs/${tabId}/resume`)).status).toBe(200);
    h.ctx.db.prepare("UPDATE tabs SET status = 'settled' WHERE id = ?").run(tabId);
    const bad = await injectJson(h.app, "POST", `/api/tabs/${tabId}/freeze`);
    expect(bad.status).toBe(409);
    expect(bad.body).toMatchObject({ error: "invalid_transition" });
    expect((await injectJson(h.app, "POST", "/api/tabs/tab_missing/resume")).status).toBe(404);
  });
});
