import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AlarmDTO,
  ClockDTO,
  CompanyDTO,
  ConfigDTO,
  GatewayEvent,
  HealthDTO,
  MetricsSummaryDTO,
  PolicyParseDTO,
  TabCreatedDTO,
  TabDetailDTO,
  TabDTO,
  TimeseriesPointDTO,
  VoucherDTO,
} from "@p402/shared";
import { generateAgentKeyPair } from "@p402/shared/node";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../src/context";
import { seedDemo, DEMO_COMPANY } from "../src/seed";
import { buildServer } from "../src/server";
import { acmeListing, createHarness, ENROLL_TOKENS, injectJson, openTab, sleep, startFakeSeller, type Harness } from "./helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe("errors", () => {
  it("renders every failure as ApiErrorDTO", async () => {
    h = await createHarness();
    const missing = await injectJson(h.app, "GET", "/api/nope");
    expect(missing).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect((await injectJson(h.app, "GET", "/nowhere")).body).toMatchObject({ error: "not_found" });

    const invalid = await injectJson<{ error: string; details: Array<{ path: string }> }>(h.app, "POST", "/api/companies", { name: "" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("invalid_request");
    expect(invalid.body.details[0]!.path).toBe("name");

    const badJson = await h.app.inject({ method: "POST", url: "/api/companies", headers: { "content-type": "application/json" }, payload: "{oops" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ error: "invalid_request" });

    const badType = await h.app.inject({ method: "POST", url: "/api/companies", headers: { "content-type": "application/xml" }, payload: "<x/>" });
    expect(badType.statusCode).toBe(415);
    expect(badType.json()).toMatchObject({ error: "unsupported_media_type" });
  });

  it("hides internals of unexpected errors and maps service AppErrors", async () => {
    const ctx = createTestContext();
    const app = await buildServer(ctx);
    app.get("/api/boom", async () => {
      throw new Error("secret stack detail");
    });
    await app.ready();
    try {
      const boom = await app.inject({ method: "GET", url: "/api/boom" });
      expect(boom.statusCode).toBe(500);
      expect(boom.json()).toEqual({ error: "internal_error", message: "Something went wrong on the gateway." });
      expect(boom.body).not.toContain("secret");
      // Unwired services surface as 503 not_wired.
      await app.inject({ method: "POST", url: "/api/companies", payload: { name: "Co" } });
      const company = (await app.inject({ method: "GET", url: "/api/companies" })).json()[0] as CompanyDTO;
      const tab = await app.inject({ method: "POST", url: "/api/tabs", payload: { companyId: company.id, policy: {} } });
      expect(tab.statusCode).toBe(503);
      expect(tab.json()).toMatchObject({ error: "not_wired" });
    } finally {
      await app.close();
    }
  });
});

describe("security plugins", () => {
  it("requires the admin token for mutating /api calls outside demo mode", async () => {
    h = await createHarness({ config: { demo: false, adminToken: "s3cret-admin" }, withSeller: false });
    const denied = await injectJson(h.app, "POST", "/api/companies", { name: "A" }, { origin: "http://localhost:5173" });
    expect(denied.body).toMatchObject({ error: "unauthorized" });
    expect(denied.res.headers["access-control-allow-origin"]).toBe("http://localhost:5173"); // readable by the web app
    expect((await injectJson(h.app, "POST", "/api/companies", { name: "A" }, { "x-p402-admin": "wrong" })).status).toBe(401);
    expect((await injectJson(h.app, "POST", "/api/companies", { name: "A" }, { "x-p402-admin": "s3cret-admin" })).status).toBe(201);
    expect((await injectJson(h.app, "GET", "/api/companies")).status).toBe(200);
    // The paywall is not an admin API: agents pay with vouchers.
    expect((await h.app.inject({ method: "POST", url: "/s/acme/v1/search" })).statusCode).toBe(404);
    const clock = await injectJson(h.app, "POST", "/api/clock/advance", { ms: 1000 }, { "x-p402-admin": "s3cret-admin" });
    expect(clock).toMatchObject({ status: 403, body: { error: "demo_only" } });
  });

  it("does not need the token in demo mode", async () => {
    h = await createHarness({ withSeller: false });
    expect((await injectJson(h.app, "POST", "/api/companies", { name: "A" })).status).toBe(201);
  });

  it("limits CORS to the web app and sets security headers (no CSP on JSON)", async () => {
    h = await createHarness({ withSeller: false });
    const ok = await h.app.inject({
      method: "OPTIONS",
      url: "/api/companies",
      headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-p402-admin" },
    });
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(String(ok.headers["access-control-allow-headers"])).toContain("x-p402-admin");
    const evil = await h.app.inject({ method: "GET", url: "/api/config", headers: { origin: "https://evil.example" } });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(evil.headers["x-content-type-options"]).toBe("nosniff");
    expect(evil.headers["content-security-policy"]).toBeUndefined();
    expect(evil.headers["cross-origin-opener-policy"]).toBeUndefined();
  });

  it("rate-limits /api but not the paywall", async () => {
    h = await createHarness({ apiRateLimit: 3 });
    for (let i = 0; i < 3; i++) expect((await injectJson(h.app, "GET", "/api/config")).status).toBe(200);
    const limited = await injectJson(h.app, "GET", "/api/config");
    expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    for (let i = 0; i < 5; i++) expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/q/ok" })).statusCode).toBe(402);
  });
});

describe("system", () => {
  it("health and config", async () => {
    h = await createHarness({ withSeller: false });
    const health = await injectJson<HealthDTO>(h.app, "GET", "/api/health");
    expect(health.body).toMatchObject({
      ok: true,
      version: "0.1.0",
      paypal: { mode: "mock", configured: true },
      llm: { provider: "mock", model: "fake-gemma", reachable: true },
      demo: true,
    });
    expect(typeof health.body.now).toBe("number");
    const config = await injectJson<ConfigDTO>(h.app, "GET", "/api/config");
    expect(config.body).toEqual({
      paypalMode: "mock",
      currency: "USD",
      demo: true,
      publicBaseUrl: "http://localhost:4020",
      llm: { provider: "mock", model: "fake-gemma" },
    });
  });

  it("health never hangs on a slow or broken LLM", async () => {
    h = await createHarness({ withSeller: false });
    h.ai.llm.health = () => new Promise(() => {});
    const started = Date.now();
    const health = await injectJson<HealthDTO>(h.app, "GET", "/api/health");
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(health.body.llm).toMatchObject({ reachable: false });
    expect(health.body.llm.detail).toMatch(/no answer/);
  });

  it("fast-forwards the demo clock and runs the scheduler", async () => {
    h = await createHarness({ withSeller: false });
    const events: string[] = [];
    h.ctx.bus.subscribe((e) => events.push(e.type));
    const before = (await injectJson<ClockDTO>(h.app, "GET", "/api/clock")).body;
    expect(before.offsetMs).toBe(0);
    const after = await injectJson<ClockDTO>(h.app, "POST", "/api/clock/advance", { ms: 86_400_000 });
    expect(after.body.offsetMs).toBe(86_400_000);
    expect(after.body.now - before.now).toBeGreaterThanOrEqual(86_400_000);
    expect(events).toContain("clock.advanced");
    expect(h.settlement.ticks).toBe(1);
    expect((await injectJson(h.app, "POST", "/api/clock/advance", { ms: -5 })).status).toBe(400);
    expect((await injectJson(h.app, "POST", "/api/clock/advance", { ms: 61 * 86_400_000 })).status).toBe(400);
  });

  it("metrics summary and timeseries", async () => {
    h = await createHarness();
    const { agent } = await openTab(h);
    await agent.call(h.app, "acme", "POST", "/v1/search", { body: '{"query":"a"}' });
    await agent.call(h.app, "acme", "GET", "/v1/products/p1");
    await agent.call(h.app, "acme", "GET", "/v1/q/500");
    const db = h.ctx.db;
    db.prepare("INSERT INTO settlements (id, tab_id, status, charged_cents, paypal_fee_cents, created_at) SELECT 's1', id, 'completed', 5000, 224, 1 FROM tabs LIMIT 1").run();
    db.prepare("INSERT INTO seller_balances (seller_id, available_micros, paid_out_micros, updated_at) VALUES ('acme', 0, 1230000, 1)").run();
    const m = (await injectJson<MetricsSummaryDTO>(h.app, "GET", "/api/metrics/summary")).body;
    expect(m).toEqual({
      calls: 3,
      accepted: 2,
      voided: 1,
      billableMicros: 7_000,
      voidedMicros: 1_000,
      settledMicros: 50_000_000,
      paypalFeeCents: 224,
      naiveFeeCents: 98,
      sellersPaidMicros: 1_230_000,
      activeTabs: 1,
      openAlarms: 0,
      reviews: 0,
    });
    const series = (await injectJson<TimeseriesPointDTO[]>(h.app, "GET", "/api/metrics/timeseries?minutes=10&bucket=60")).body;
    expect(series).toHaveLength(10);
    expect(series.at(-1)).toMatchObject({ calls: 3, voids: 1, spendMicros: 7_000, bySeller: { acme: 7_000 } });
    expect(series[0]).toMatchObject({ calls: 0, spendMicros: 0, bySeller: {} });
    expect(series[1]!.t - series[0]!.t).toBe(60_000);
    expect((await injectJson(h.app, "GET", "/api/metrics/timeseries?minutes=0")).status).toBe(400);
  });
});

describe("companies, policies and tabs", () => {
  it("creates companies and parses plain-English policies against the catalog", async () => {
    h = await createHarness();
    const created = await injectJson<CompanyDTO>(h.app, "POST", "/api/companies", { name: "  Northwind  " });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: "Northwind" });
    expect(created.body.id).toMatch(/^co_/);
    expect((await injectJson<CompanyDTO[]>(h.app, "GET", "/api/companies")).body).toHaveLength(1);
    const parsed = await injectJson<PolicyParseDTO>(h.app, "POST", "/api/policy/parse", { text: "$5 a day, only acme" });
    expect(parsed.body.summary[0]).toBe('Parsed "$5 a day, only acme" against 1 seller(s)');
    expect((await injectJson(h.app, "POST", "/api/policy/parse", { text: "" })).status).toBe(400);
  });

  it("opens tabs through the settlement service: one open tab per company", async () => {
    h = await createHarness();
    const company = (await injectJson<CompanyDTO>(h.app, "POST", "/api/companies", { name: "Co" })).body;
    expect((await injectJson(h.app, "POST", "/api/tabs", { companyId: "co_missing", policy: {} })).status).toBe(404);
    expect((await injectJson(h.app, "POST", "/api/tabs", { companyId: company.id, policy: { holdCents: 5 } })).status).toBe(400);
    expect((await injectJson(h.app, "POST", "/api/tabs", { companyId: company.id })).status).toBe(400);

    const first = await injectJson<TabCreatedDTO>(h.app, "POST", "/api/tabs", {
      companyId: company.id,
      label: "Espresso research",
      policy: { holdCents: 2_000, closeAtCents: 9_999, alarms: { errorStreak: 3 } },
      policyText: "$20 hold",
    });
    expect(first.status).toBe(201);
    expect(first.body.tab).toMatchObject({ status: "pending_approval", holdCents: 2_000, label: "Espresso research", policyText: "$20 hold" });
    // normalized: closeAt <= hold, alarms merged over the defaults
    expect(first.body.tab.policy).toMatchObject({ closeAtCents: 2_000, alarms: { errorStreak: 3, repeatRequestThreshold: 5 } });
    expect(first.body.approveUrl).toContain("/paypal/mock/approve");

    // A tab still awaiting approval does not block a retry; an active one does.
    const second = await injectJson<TabCreatedDTO>(h.app, "POST", "/api/tabs", { companyId: company.id, policy: {} });
    expect(second.status).toBe(201);
    h.settlement.approve(second.body.tab.id);
    const third = await injectJson(h.app, "POST", "/api/tabs", { companyId: company.id, policy: {} });
    expect(third).toMatchObject({ status: 409, body: { error: "tab_already_open", details: { tabId: second.body.tab.id } } });

    const list = await injectJson<TabDTO[]>(h.app, "GET", `/api/tabs?companyId=${company.id}`);
    expect(list.body.map((t) => t.id)).toEqual([second.body.tab.id, first.body.tab.id]);
    expect((await injectJson<TabDTO[]>(h.app, "GET", "/api/tabs?status=active,paused")).body.map((t) => t.id)).toEqual([second.body.tab.id]);
    expect((await injectJson(h.app, "GET", "/api/tabs?status=bogus")).status).toBe(400);
  });

  it("returns tab detail with channels, alarms, reviews and settlements", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { alarms: { repeatRequestThreshold: 2 } });
    await agent.call(h.app, "acme", "GET", "/v1/products/p1");
    await agent.call(h.app, "acme", "GET", "/v1/products/p1");
    await h.idle();
    h.ctx.db.prepare("INSERT INTO settlements (id, tab_id, status, created_at) VALUES ('stl_1', ?, 'failed', 5)").run(tabId);
    const detail = (await injectJson<TabDetailDTO>(h.app, "GET", `/api/tabs/${tabId}`)).body;
    expect(detail.channels).toEqual([{ sellerId: "acme", lastSeq: 2, lastCumulativeMicros: 4_000 }]);
    expect(detail.alarms).toHaveLength(1);
    expect(detail.reviews).toHaveLength(1);
    expect(detail.settlements).toEqual([expect.objectContaining({ id: "stl_1", status: "failed", lines: [] })]);
    expect(detail.totals).toMatchObject({ calls: 2, accepted: 2, billableMicros: 4_000 });
    expect((await injectJson(h.app, "GET", "/api/tabs/tab_missing")).status).toBe(404);
  });

  it("enrolls agent keys only with the tab's token, in constant time, on enrollable tabs", async () => {
    h = await createHarness();
    const company = (await injectJson<CompanyDTO>(h.app, "POST", "/api/companies", { name: "Co" })).body;
    const created = (await injectJson<TabCreatedDTO>(h.app, "POST", "/api/tabs", { companyId: company.id, policy: {} })).body;
    const tabId = created.tab.id;
    expect(ENROLL_TOKENS.get(tabId)).toBe(created.enrollToken);
    const key = generateAgentKeyPair().publicKey;
    const enroll = (body: Record<string, unknown>) =>
      injectJson(h.app, "POST", `/api/tabs/${tabId}/keys`, { agentId: "cli-agent", publicKey: key, enrollToken: created.enrollToken, ...body });

    expect((await enroll({ enrollToken: "wrong" })).body).toMatchObject({ error: "invalid_enroll_token" });
    expect((await enroll({ publicKey: "too-short" })).status).toBe(400);
    expect((await enroll({ agentId: "bad id with spaces" })).status).toBe(400);
    expect((await enroll({})).body).toEqual({ ok: true }); // pending approval is fine
    expect((await enroll({})).body).toEqual({ ok: true }); // idempotent
    expect((await enroll({ publicKey: generateAgentKeyPair().publicKey })).body).toMatchObject({ error: "agent_exists" });
    h.ctx.db.prepare("UPDATE tabs SET status = 'settled' WHERE id = ?").run(tabId);
    expect((await enroll({ agentId: "late" })).body).toMatchObject({ error: "tab_not_enrollable" });
    expect((await injectJson(h.app, "POST", "/api/tabs/tab_missing/keys", { agentId: "a", publicKey: key, enrollToken: "x" })).status).toBe(404);
  });
});

describe("ledger queries", () => {
  it("filters and pages vouchers, alarms and reviews", async () => {
    h = await createHarness();
    const { tabId, agent } = await openTab(h, { alarms: { repeatRequestThreshold: 3 } });
    const other = await openTab(h);
    for (const kase of ["ok", "500", "ok2", "404"]) await agent.call(h.app, "acme", "GET", `/v1/q/${kase}`);
    await other.agent.call(h.app, "acme", "GET", "/v1/q/ok");
    const all = (await injectJson<VoucherDTO[]>(h.app, "GET", `/api/vouchers?tabId=${tabId}`)).body;
    expect(all.map((v) => v.seq)).toEqual([4, 3, 2, 1]);
    expect((await injectJson<VoucherDTO[]>(h.app, "GET", `/api/vouchers?tabId=${tabId}&status=voided`)).body.map((v) => v.seq)).toEqual([4, 2]);
    expect((await injectJson<VoucherDTO[]>(h.app, "GET", "/api/vouchers?limit=2")).body).toHaveLength(2);
    expect((await injectJson<VoucherDTO[]>(h.app, "GET", "/api/vouchers?sellerId=acme")).body).toHaveLength(5);
    const before = all[1]!.createdAt;
    const older = (await injectJson<VoucherDTO[]>(h.app, "GET", `/api/vouchers?tabId=${tabId}&before=${before}`)).body;
    expect(older.every((v) => v.createdAt < before)).toBe(true);
    expect((await injectJson(h.app, "GET", "/api/vouchers?limit=5000")).status).toBe(400);
    expect((await injectJson(h.app, "GET", "/api/vouchers?status=pending")).status).toBe(400);

    for (let i = 0; i < 3; i++) await agent.call(h.app, "acme", "GET", "/v1/q/same");
    await h.idle();
    expect((await injectJson<AlarmDTO[]>(h.app, "GET", `/api/alarms?tabId=${tabId}`)).body).toHaveLength(1);
    expect((await injectJson<AlarmDTO[]>(h.app, "GET", `/api/alarms?tabId=${other.tabId}`)).body).toHaveLength(0);
    expect((await injectJson<AlarmDTO[]>(h.app, "GET", "/api/alarms?status=resolved")).body).toHaveLength(1);
    expect((await injectJson<unknown[]>(h.app, "GET", `/api/reviews?tabId=${tabId}`)).body).toHaveLength(1);
    expect((await injectJson(h.app, "POST", "/api/reviews/rev_missing/decide", { verdict: "resume" })).status).toBe(404);
    expect((await injectJson(h.app, "POST", "/api/reviews/rev_missing/decide", { verdict: "maybe" })).status).toBe(400);
  });
});

describe("ai routes", () => {
  it("proxies grid queries and chat to the AI service with validation", async () => {
    h = await createHarness({ withSeller: false });
    const grid = await injectJson<{ state: Record<string, unknown> }>(h.app, "POST", "/api/ai/grid-query", {
      question: "voided calls by seller",
      schema: { columns: [] },
      state: { sort: [] },
    });
    expect(grid.body.state).toEqual({ sort: [], filter: { q: "voided calls by seller" } });
    expect((await injectJson(h.app, "POST", "/api/ai/grid-query", { question: "x" })).status).toBe(400);
    const chat = await injectJson<{ choices: Array<{ message: { content: string } }> }>(h.app, "POST", "/api/ai/chat", {
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    expect(chat.body.choices[0]!.message.content).toBe("echo: hello");
    expect((await injectJson(h.app, "POST", "/api/ai/chat", { messages: [] })).status).toBe(400);
  });
});

describe("websocket", () => {
  it("sends a metrics snapshot on connect, then every event, then throttled metrics", async () => {
    h = await createHarness({ metricsIntervalMs: 40 });
    const received: GatewayEvent[] = [];
    const ws = await h.app.injectWS("/ws", {}, {
      onInit: (socket) => socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString()) as GatewayEvent)),
    });
    await sleep(20);
    expect(received[0]?.type).toBe("metrics");
    const { agent } = await openTab(h);
    await agent.call(h.app, "acme", "GET", "/v1/q/ok");
    await sleep(120);
    const types = received.map((e) => e.type);
    expect(types).toContain("voucher.accepted");
    const lastMetrics = received.filter((e) => e.type === "metrics").at(-1) as Extract<GatewayEvent, { type: "metrics" }>;
    expect(lastMetrics.data.calls).toBe(1);
    expect(types.filter((t) => t === "metrics").length).toBeLessThanOrEqual(4);
    ws.terminate();
  });

  it("rejects browsers from foreign origins", async () => {
    h = await createHarness({ withSeller: false });
    await expect(h.app.injectWS("/ws", { headers: { origin: "https://evil.example" } })).rejects.toThrow();
    const ok = await h.app.injectWS("/ws", { headers: { origin: "http://localhost:5173" } });
    ok.terminate();
  });
});

describe("web app serving", () => {
  it("serves the built app with a strict CSP and an SPA fallback, never for API paths", async () => {
    const dist = mkdtempSync(join(tmpdir(), "p402-web-"));
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>402 Fiatality</title>");
    writeFileSync(join(dist, "assets", "app.js"), "console.log(1)");
    try {
      h = await createHarness({ config: { serveWeb: true, webDistDir: dist } });
      const index = await h.app.inject({ method: "GET", url: "/" });
      expect(index.statusCode).toBe(200);
      expect(index.body).toContain("402 Fiatality");
      expect(index.headers["content-security-policy"]).toContain("script-src 'self'");
      expect(index.headers["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
      const deep = await h.app.inject({ method: "GET", url: "/statements/tab_123" });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toContain("402 Fiatality");
      expect((await h.app.inject({ method: "GET", url: "/assets/app.js" })).body).toBe("console.log(1)");
      expect((await h.app.inject({ method: "GET", url: "/api/nope" })).json()).toMatchObject({ error: "not_found" });
      expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/q/ok" })).statusCode).toBe(402);
      expect((await h.app.inject({ method: "POST", url: "/console" })).statusCode).toBe(404);
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  });
});

describe("demo seeding", () => {
  it("seeds Northwind and the demo sellers idempotently, skipping bad listings", async () => {
    const seller = await startFakeSeller();
    try {
      const ctx = createTestContext({
        demoSellers: () => [acmeListing(seller.url), { ...acmeListing(seller.url), id: "broken", baseUrl: "http://10.0.0.1" }],
      });
      const first = await seedDemo(ctx);
      expect(first).toEqual({ sellers: ["acme"], failed: ["broken"] });
      const second = await seedDemo(ctx);
      expect(second.sellers).toEqual(["acme"]);
      expect(ctx.db.prepare("SELECT id, name FROM companies").all()).toEqual([DEMO_COMPANY]);
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM endpoints").get()).toEqual({ n: 5 });
      // The default stub has no sellers yet: still seeds the company.
      const empty = createTestContext();
      expect(await seedDemo(empty)).toEqual({ sellers: [], failed: [] });
      expect(empty.db.prepare("SELECT id FROM companies").all()).toEqual([{ id: "co_northwind" }]);
    } finally {
      await seller.close();
    }
  });
});
