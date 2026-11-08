import { DEFAULT_POLICY, DEFAULT_VOID_RULES, type GatewayEvent } from "@p402/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { ClockLockedError, createClock, DAY_MS } from "./clock";
import { ConfigError, loadConfig } from "./config";
import { AppError, createTestContext, REDACT_PATHS } from "./context";
import { kvGet, openDb, SCHEMA_VERSION } from "./db/db";
import { agentStepDTO, agentStepRow, getSellerDTO, getTabDTO, listTabDTOs, settlementDTO, type SettlementRow } from "./db/dto";

describe("config", () => {
  it("defaults to fully offline demo mode", () => {
    const c = loadConfig({});
    expect(c.paypal.mode).toBe("mock");
    expect(c.llm).toMatchObject({ provider: "mock", model: "gemma4:12b", baseUrl: "http://localhost:11434" });
    expect(c.demo).toBe(true);
    expect(c.port).toBe(4020);
    expect(c.publicBaseUrl).toBe("http://localhost:4020");
    expect(c.sellersBaseUrl).toBe("http://localhost:4030");
    expect(c.webBaseUrl).toBe("http://localhost:5173");
    expect(c.dbPath.endsWith("data/p402.sqlite")).toBe(true);
    expect(c.reviewBudgetMs).toBe(45_000);
  });

  it("parses values, treats blanks as unset and trims trailing slashes", () => {
    const c = loadConfig({
      PORT: "5000",
      PUBLIC_BASE_URL: "https://gw.example.com/",
      DEMO_MODE: "0",
      ADMIN_TOKEN: "t0ken",
      LLM_PROVIDER: "ollama",
      LLM_BASE_URL: "",
      CHANNEL3_API_KEY: "  ",
      FLAKY_RATE: "0.5",
      LLM_REVIEW_BUDGET_MS: "90000",
    });
    expect(c.reviewBudgetMs).toBe(90_000);
    expect(c.port).toBe(5000);
    expect(c.publicBaseUrl).toBe("https://gw.example.com");
    expect(c.demo).toBe(false);
    expect(c.llm.baseUrl).toBe("http://localhost:11434");
    expect(c.channel3ApiKey).toBeNull();
    expect(c.flakyRate).toBe(0.5);
  });

  it("fails fast on unusable combinations without echoing secrets", () => {
    expect(() => loadConfig({ PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "id" })).toThrow(ConfigError);
    expect(() => loadConfig({ DEMO_MODE: "0" })).toThrow(/ADMIN_TOKEN/);
    try {
      loadConfig({ PORT: "not-a-port-s3cret" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/PORT/);
      expect(String(err)).not.toMatch(/s3cret/);
    }
  });
});

describe("db and clock", () => {
  it("applies the schema once and enforces foreign keys", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["tabs", "vouchers", "settlement_lines", "events_log", "kv"]));
    expect(() =>
      db.prepare("INSERT INTO tabs (id, company_id, status, policy, hold_cents, enroll_token_hash, created_at) VALUES ('t', 'nope', 'active', '{}', 100, 'h', 0)").run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it("persists the demo offset and ignores it outside demo mode", () => {
    const db = openDb(":memory:");
    const clock = createClock(db, { demo: true, realNow: () => 1_000 });
    expect(clock.advance(DAY_MS)).toEqual({ now: 1_000 + DAY_MS, offsetMs: DAY_MS });
    expect(kvGet(db, "clock.offset_ms")).toBe(String(DAY_MS));
    expect(createClock(db, { demo: true, realNow: () => 1_000 }).now()).toBe(1_000 + DAY_MS);

    const real = createClock(db, { demo: false, realNow: () => 1_000 });
    expect(real.now()).toBe(1_000);
    expect(() => real.advance(1)).toThrow(ClockLockedError);
    expect(() => clock.advance(-5)).toThrow(RangeError);
  });
});

describe("event bus", () => {
  it("stamps, persists (except metrics) and isolates failing listeners", () => {
    const ctx = createTestContext({ realNow: () => 42 });
    const seen: GatewayEvent[] = [];
    ctx.bus.subscribe(() => {
      throw new Error("listener bug");
    });
    ctx.bus.subscribe((e) => seen.push(e));
    const onlyClock: string[] = [];
    const off = ctx.bus.on("clock.advanced", (e) => onlyClock.push(e.type));

    ctx.bus.emit("clock.advanced", { now: 42, offsetMs: 0 });
    ctx.bus.emit("metrics", {
      calls: 0, accepted: 0, voided: 0, billableMicros: 0, voidedMicros: 0, settledMicros: 0,
      paypalFeeCents: 0, naiveFeeCents: 0, sellersPaidMicros: 0, activeTabs: 0, openAlarms: 0, reviews: 0,
    });
    off();
    ctx.bus.emit("clock.advanced", { now: 43, offsetMs: 1 });

    expect(seen.map((e) => e.type)).toEqual(["clock.advanced", "metrics", "clock.advanced"]);
    expect(seen[0]?.at).toBe(42);
    expect(onlyClock).toEqual(["clock.advanced"]);
    const logged = ctx.db.prepare("SELECT type FROM events_log ORDER BY id").all() as Array<{ type: string }>;
    expect(logged.map((r) => r.type)).toEqual(["clock.advanced", "clock.advanced"]);
  });
});

describe("dto mappers", () => {
  function seed() {
    const ctx = createTestContext({ realNow: () => 10 * DAY_MS + 5_000 });
    const db = ctx.db;
    db.prepare("INSERT INTO companies (id, name, created_at) VALUES ('co_1', 'Northwind Research', 1)").run();
    db.prepare(
      "INSERT INTO sellers (id, name, base_url, auth_header, api_key_enc, paypal_email, void_rules, created_at) VALUES ('channel3', 'Channel3', 'http://localhost:4030/channel3', 'x-api-key', 'iv.tag.ct', 's@example.com', '{\"emptyResultPaths\":[\"products\"]}', 1)",
    ).run();
    db.prepare("INSERT INTO endpoints (id, seller_id, method, path, price_micros) VALUES ('ep_1', 'channel3', 'POST', '/v1/search', 5000)").run();
    db.prepare(
      "INSERT INTO tabs (id, company_id, status, policy, hold_cents, enroll_token_hash, created_at) VALUES ('tab_1', 'co_1', 'active', ?, 5000, 'h', 2)",
    ).run(JSON.stringify(DEFAULT_POLICY));
    const voucher = db.prepare(
      "INSERT INTO vouchers (id, tab_id, seller_id, endpoint_id, seq, price_micros, cumulative_micros, req_hash, method, path, status, signature, created_at) VALUES (?, 'tab_1', 'channel3', 'ep_1', ?, 5000, ?, 'rh', 'POST', '/v1/search', ?, 'sig', ?)",
    );
    voucher.run("v1", 1, 5_000, "accepted", 9 * DAY_MS); // yesterday
    voucher.run("v2", 2, 10_000, "accepted", 10 * DAY_MS + 1);
    voucher.run("v3", 3, 15_000, "voided", 10 * DAY_MS + 2);
    voucher.run("v4", 4, 20_000, "pending", 10 * DAY_MS + 3);
    return ctx;
  }

  it("renders tabs with totals over judged vouchers only", () => {
    const ctx = seed();
    const tab = getTabDTO(ctx.db, "tab_1", ctx.clock.now());
    expect(tab?.companyName).toBe("Northwind Research");
    expect(tab?.policy).toEqual(DEFAULT_POLICY);
    expect(tab?.totals).toEqual({
      calls: 3,
      accepted: 2,
      voided: 1,
      billableMicros: 10_000,
      voidedMicros: 5_000,
      remainingMicros: 50_000_000 - 10_000,
      spentTodayMicros: 5_000,
    });
    expect(listTabDTOs(ctx.db, ctx.clock.now(), { statuses: ["settled"] })).toEqual([]);
    expect(listTabDTOs(ctx.db, ctx.clock.now(), { companyId: "co_1" })).toHaveLength(1);
  });

  it("renders sellers without secrets", () => {
    const ctx = seed();
    const seller = getSellerDTO(ctx.db, "channel3", "http://localhost:4020");
    expect(seller).toMatchObject({
      hasApiKey: true,
      gatewayUrl: "http://localhost:4020/s/channel3",
      voidRules: { ...DEFAULT_VOID_RULES, emptyResultPaths: ["products"] },
      stats: { calls: 3, voids: 1, grossMicros: 10_000 },
      balanceMicros: 0,
    });
    expect(JSON.stringify(seller)).not.toContain("iv.tag.ct");
  });

  it("round-trips agent steps and renders settlement lines", () => {
    const ctx = seed();
    const step = { runId: "run_1", index: 3, kind: "paid_call" as const, text: "search", at: 7, costMicros: 5_000, sellerId: "channel3" };
    expect(agentStepDTO(agentStepRow(step))).toEqual(step);

    ctx.db.prepare("INSERT INTO settlements (id, tab_id, status, charged_cents, paypal_fee_cents, created_at) VALUES ('stl_1', 'tab_1', 'completed', 100, 52, 3)").run();
    ctx.db.prepare("INSERT INTO settlement_lines VALUES ('stl_1', 'channel3', 1000000, 520000, 480000, 200)").run();
    const row = ctx.db.prepare("SELECT * FROM settlements WHERE id = 'stl_1'").get() as SettlementRow;
    expect(settlementDTO(ctx.db, row).lines).toEqual([
      { sellerId: "channel3", sellerName: "Channel3", grossMicros: 1_000_000, feeShareMicros: 520_000, netMicros: 480_000, calls: 200 },
    ]);
  });
});

describe("context", () => {
  it("redacts secrets at the top level and one level down", () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, { write: (s: string) => lines.push(s) });
    log.info({ apiKey: "LEAK1", seller: { apiKey: "LEAK2", clientSecret: "LEAK3" }, req: { headers: { "x-api-key": "LEAK4" } } }, "x");
    expect(lines.join("")).not.toMatch(/LEAK/);
  });

  it("uses throwing stubs until services are wired", async () => {
    const ctx = createTestContext();
    expect(ctx.paypal.mode).toBe("mock");
    await expect(ctx.settlement.createHold({ companyId: "c", policy: DEFAULT_POLICY })).rejects.toBeInstanceOf(AppError);
    await expect(ctx.ai.parsePolicy("$5 a day", [])).rejects.toMatchObject({ status: 503, code: "not_wired" });
    expect(await ctx.ai.llm.health()).toMatchObject({ reachable: false });
    expect(ctx.demoSellers(ctx.config)).toEqual([]);
    expect(() => ctx.settlement.start()).not.toThrow();
  });

  it("builds factories against the context being assembled", () => {
    const ctx = createTestContext({
      settlement: (c) => ({ ...createTestContext().settlement, statement: async () => ({ mode: c.paypal.mode }) as never }),
    });
    return expect(ctx.settlement.statement("x")).resolves.toEqual({ mode: "mock" });
  });
});
