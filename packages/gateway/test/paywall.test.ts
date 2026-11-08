import { X402_HEADERS, type PaymentRequired, type VoucherDTO } from "@p402/shared";
import { encodeX402Header, generateAgentKeyPair } from "@p402/shared/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACME_API_KEY, createHarness, injectJson, openTab, type Harness, type TestAgent } from "./helpers";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.close();
});

const SEARCH_BODY = JSON.stringify({ query: "espresso machine", limit: 5 });

describe("402 quote", () => {
  it("answers an unpaid call with PAYMENT-REQUIRED (header and body agree) and never reaches the seller", async () => {
    const res = await h.app.inject({ method: "POST", url: "/s/acme/v1/search", headers: { "content-type": "application/json" }, payload: SEARCH_BODY });
    expect(res.statusCode).toBe(402);
    const header = JSON.parse(Buffer.from(res.headers["payment-required"] as string, "base64").toString("utf8")) as PaymentRequired;
    expect(header).toEqual(res.json());
    expect(header.x402Version).toBe(2);
    expect(header.resource.url).toBe("http://localhost:4020/s/acme/v1/search");
    const req = header.accepts[0]!;
    expect(req).toMatchObject({
      scheme: "batch-settlement",
      network: "paypal:mock",
      asset: "USD",
      amount: "5000",
      payTo: "acme",
      maxTimeoutSeconds: 300,
      extra: {
        decimals: 6,
        tabEndpoint: "http://localhost:4020/api/tabs",
        catalogUrl: "http://localhost:4020/api/catalog",
        reason: "payment_required",
      },
    });
    expect(req.extra.endpointId).toMatch(/^ep_/);
    expect(req.extra.voidRules).toMatchObject({ timeoutMs: 400, emptyResultPaths: ["products"], on5xx: true });
    expect(h.seller.requests).toHaveLength(0);
  });

  it("404s unknown sellers, endpoints and unsafe paths without a quote", async () => {
    expect((await h.app.inject({ method: "GET", url: "/s/nobody/v1/x" })).json()).toMatchObject({ error: "seller_not_found" });
    const unknown = await h.app.inject({ method: "GET", url: "/s/acme/v1/nothing-here" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: "endpoint_not_found" });
    expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/products/%2e%2e" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/products/a%2Fb" })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "DELETE", url: "/s/acme/v1/search" })).statusCode).toBe(404);
  });

  it("503s a paused seller", async () => {
    await injectJson(h.app, "PATCH", "/api/sellers/acme", { status: "paused" });
    expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/q/ok" })).statusCode).toBe(503);
  });
});

describe("paid calls", () => {
  it("forwards the exact body with the seller key, then answers with PAYMENT-RESPONSE", async () => {
    const { tabId, agent } = await openTab(h);
    const events: string[] = [];
    h.ctx.bus.subscribe((e) => events.push(e.type));
    const r = await agent.call(h.app, "acme", "POST", "/v1/search", { body: SEARCH_BODY });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ products: [{ id: "p1" }], query: SEARCH_BODY });
    expect(r.payment).toMatchObject({
      success: true,
      scheme: "batch-settlement",
      network: "paypal:mock",
      status: "accepted",
      amount: "5000",
      cumulative: "5000",
    });
    expect(r.payment?.transaction).toMatch(/^vch_/);

    const seen = h.seller.requests[0]!;
    expect(seen.url).toBe("/acme/v1/search");
    expect(seen.body).toBe(SEARCH_BODY);
    expect(seen.headers["x-api-key"]).toBe(ACME_API_KEY);
    expect(seen.headers["x-p402-voucher"]).toBe(r.payment?.transaction);
    expect(seen.headers["payment-signature"]).toBeUndefined();

    const vouchers = await injectJson<VoucherDTO[]>(h.app, "GET", `/api/vouchers?tabId=${tabId}`);
    expect(vouchers.body).toHaveLength(1);
    expect(vouchers.body[0]).toMatchObject({ id: r.payment?.transaction, status: "accepted", seq: 1, priceMicros: 5_000, method: "POST", path: "/v1/search" });
    expect(events).toContain("voucher.accepted");
    const row = h.ctx.db.prepare("SELECT signature, request_excerpt, response_excerpt FROM vouchers").get() as Record<string, string>;
    expect(Buffer.from(row.signature!, "base64").toString()).toContain('"payload"');
    expect(row.request_excerpt).toBe(`POST /v1/search\n${SEARCH_BODY}`);
    expect(row.response_excerpt).toContain("Espresso machine");
  });

  it("forwards only allow-listed request headers and keeps the query string", async () => {
    const { agent } = await openTab(h);
    const res = await h.app.inject({
      method: "GET",
      url: "/s/acme/v1/q/echo?color=red&size=2",
      headers: {
        [X402_HEADERS.signature]: agent.header({ sellerId: "acme", method: "GET", path: "/v1/q/echo?color=red&size=2", price: 1_000 }),
        authorization: "Bearer client-token",
        cookie: "session=1",
        "x-api-key": "client-chosen-key",
        "x-p402-admin": "nope",
        accept: "application/json",
        "user-agent": "test-agent/1",
      },
    });
    expect(res.statusCode).toBe(200);
    const echoed = res.json() as { url: string; headers: Record<string, string> };
    expect(echoed.url).toBe("/acme/v1/q/echo?color=red&size=2");
    expect(echoed.headers["x-api-key"]).toBe(ACME_API_KEY);
    expect(echoed.headers.authorization).toBeUndefined();
    expect(echoed.headers.cookie).toBeUndefined();
    expect(echoed.headers["x-p402-admin"]).toBeUndefined();
    expect(echoed.headers["payment-signature"]).toBeUndefined();
    expect(echoed.headers.accept).toBe("application/json");
    expect(echoed.headers["user-agent"]).toBe("test-agent/1");
  });
});

describe("verification matrix", () => {
  let tabId: string;
  let agent: TestAgent;
  beforeEach(async () => {
    ({ tabId, agent } = await openTab(h));
  });

  const reasonOf = async (header: string, url = "/s/acme/v1/products/p1", method: "GET" | "POST" = "GET") => {
    const res = await h.app.inject({ method, url, headers: { [X402_HEADERS.signature]: header } });
    const required = res.json() as PaymentRequired;
    return { status: res.statusCode, extra: required.accepts?.[0]?.extra, res };
  };
  const sign = (o: Partial<Parameters<TestAgent["header"]>[0]> = {}) =>
    agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/p1", price: 2_000, ...o });

  it("invalid_voucher: undecodable header, wrong shape, scheme or network, unknown members", async () => {
    expect((await reasonOf("%%%not-base64%%%")).extra?.reason).toBe("invalid_voucher");
    expect((await reasonOf(encodeX402Header({ hello: "world" }))).extra?.reason).toBe("invalid_voucher");
    expect((await reasonOf(sign({ accepted: { scheme: "exact" as never } }))).extra?.reason).toBe("invalid_voucher");
    const wrongNet = await reasonOf(sign({ accepted: { network: "paypal:sandbox" } }));
    expect(wrongNet.extra).toMatchObject({ reason: "invalid_voucher" });
    expect(wrongNet.extra?.message).toMatch(/paypal:mock/);
    expect((await reasonOf(sign({ voucher: { extraField: 1 } }))).extra?.reason).toBe("invalid_voucher");
    expect((await reasonOf(sign({ voucher: { price: "2e3" } }))).extra?.reason).toBe("invalid_voucher");
  });

  it("invalid_voucher: request hash bound to method, path, query and body", async () => {
    expect((await reasonOf(sign({ path: "/v1/products/p2" }))).extra?.reason).toBe("invalid_voucher");
    expect((await reasonOf(sign({ path: "/v1/products/p1?x=1" }))).extra?.reason).toBe("invalid_voucher");
    expect((await reasonOf(sign({ method: "POST" }))).extra?.reason).toBe("invalid_voucher");
    const res = await h.app.inject({
      method: "POST",
      url: "/s/acme/v1/search",
      headers: {
        [X402_HEADERS.signature]: agent.header({ sellerId: "acme", method: "POST", path: "/v1/search", body: '{"query":"a"}', price: 5_000 }),
        "content-type": "application/json",
      },
      payload: '{"query":"b"}',
    });
    expect((res.json() as PaymentRequired).accepts[0]?.extra.reason).toBe("invalid_voucher");
    expect(h.seller.requests).toHaveLength(0);
  });

  it("tab_not_found, tab_not_active, tab_paused (+Retry-After) and tab_frozen", async () => {
    expect((await reasonOf(sign({ voucher: { tab: "tab_missing" } }))).extra?.reason).toBe("tab_not_found");

    const setStatus = (status: string) => h.ctx.db.prepare("UPDATE tabs SET status = ? WHERE id = ?").run(status, tabId);
    setStatus("pending_approval");
    expect((await reasonOf(sign())).extra?.reason).toBe("tab_not_active");
    setStatus("settled");
    expect((await reasonOf(sign())).extra?.reason).toBe("tab_not_active");
    setStatus("paused");
    const paused = await reasonOf(sign());
    expect(paused.extra?.reason).toBe("tab_paused");
    expect(paused.extra?.retryAfterSec).toBeGreaterThan(0);
    expect(paused.res.headers["retry-after"]).toBe(String(paused.extra?.retryAfterSec));
    setStatus("frozen");
    expect((await reasonOf(sign())).extra?.reason).toBe("tab_frozen");
  });

  it("invalid_signature: unknown agent, other key, tampered voucher, no agent", async () => {
    expect((await reasonOf(sign({ agentId: "stranger" }))).extra?.reason).toBe("invalid_signature");
    expect((await reasonOf(sign({ privateKey: generateAgentKeyPair().privateKey }))).extra?.reason).toBe("invalid_signature");
    expect((await reasonOf(sign({ agentId: null }))).extra?.reason).toBe("invalid_signature");
    const payload = JSON.parse(Buffer.from(sign(), "base64").toString("utf8"));
    payload.payload.voucher.cumulative = "1"; // edited after signing
    expect((await reasonOf(encodeX402Header(payload))).extra?.reason).toBe("invalid_signature");
  });

  it("amount_mismatch: wrong price or another seller's voucher", async () => {
    const wrongPrice = await reasonOf(sign({ price: 1_500 }));
    expect(wrongPrice.extra).toMatchObject({ reason: "amount_mismatch", expectedSeq: 1, expectedCumulative: "2000" });
    expect(wrongPrice.res.json().accepts[0].amount).toBe("2000");
    expect((await reasonOf(sign({ sellerId: "other" }))).extra?.reason).toBe("amount_mismatch");
    await agent.call(h.app, "acme", "GET", "/v1/products/p1");
    expect((await reasonOf(sign({ price: 1_500, seq: 2, cumulative: 3_500 }))).extra).toMatchObject({
      expectedSeq: 2,
      expectedCumulative: "4000",
    });
  });

  it("voucher_expired: expired, issued in the future, or living longer than 300 s", async () => {
    const now = agent.nowSec();
    expect((await reasonOf(sign({ iat: now - 200, exp: now - 1 }))).extra?.reason).toBe("voucher_expired");
    expect((await reasonOf(sign({ iat: now + 120, exp: now + 200 }))).extra?.reason).toBe("voucher_expired");
    expect((await reasonOf(sign({ iat: now, exp: now + 301 }))).extra?.reason).toBe("voucher_expired");
    expect((await reasonOf(sign({ iat: now + 20, exp: now + 100 }))).status).toBe(200); // small clock skew is fine
  });

  it("voucher freshness uses wall-clock time, not the fast-forwarded demo clock", async () => {
    h.ctx.clock.advance(5 * 86_400_000);
    const r = await agent.call(h.app, "acme", "GET", "/v1/products/p1", { iat: Math.floor(Date.now() / 1000) });
    expect(r.status).toBe(200);
  });

  it("stale_sequence: replay, gaps and wrong cumulative report what the next voucher must carry", async () => {
    const header = sign();
    expect((await reasonOf(header)).status).toBe(200);
    const replay = await reasonOf(header);
    expect(replay.extra).toMatchObject({ reason: "stale_sequence", expectedSeq: 2, expectedCumulative: "4000" });
    expect((await reasonOf(sign({ seq: 3, cumulative: 6_000 }))).extra).toMatchObject({ reason: "stale_sequence", expectedSeq: 2 });
    expect((await reasonOf(sign({ seq: 2, cumulative: 5_000 }))).extra).toMatchObject({ reason: "stale_sequence", expectedCumulative: "4000" });
    expect((await reasonOf(sign({ seq: 2, cumulative: 4_000 }))).status).toBe(200);
    expect(h.seller.requests).toHaveLength(2);
  });

  it("a resynced agent continues from expectedSeq/expectedCumulative", async () => {
    await agent.call(h.app, "acme", "GET", "/v1/products/p1");
    agent.setChannel("acme", 0, 0); // lost its state
    const stale = await agent.call(h.app, "acme", "GET", "/v1/products/p2");
    expect(stale.reason).toBe("stale_sequence");
    const extra = stale.required!.accepts[0]!.extra;
    agent.setChannel("acme", extra.expectedSeq! - 1, Number(extra.expectedCumulative) - 2_000);
    expect((await agent.call(h.app, "acme", "GET", "/v1/products/p2")).status).toBe(200);
  });
});

describe("double spend", () => {
  it("lets exactly one of two concurrent vouchers with the same sequence through", async () => {
    const { agent } = await openTab(h);
    const a = agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/a", price: 2_000 });
    const b = agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/b", price: 2_000 });
    const [ra, rb] = await Promise.all([
      h.app.inject({ method: "GET", url: "/s/acme/v1/products/a", headers: { [X402_HEADERS.signature]: a } }),
      h.app.inject({ method: "GET", url: "/s/acme/v1/products/b", headers: { [X402_HEADERS.signature]: b } }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 402]);
    const loser = ra.statusCode === 402 ? ra : rb;
    expect((loser.json() as PaymentRequired).accepts[0]?.extra.reason).toBe("stale_sequence");
    expect(h.seller.requests).toHaveLength(1);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM vouchers").get()).toEqual({ n: 1 });
  });

  it("a voided call still advances the channel (the agent signed it)", async () => {
    const { tabId, agent } = await openTab(h);
    const failed = await agent.call(h.app, "acme", "GET", "/v1/q/500");
    expect(failed.payment).toMatchObject({ status: "voided", amount: "0", cumulative: "1000", success: false });
    const next = await agent.call(h.app, "acme", "GET", "/v1/q/ok");
    expect(next.payment).toMatchObject({ status: "accepted", cumulative: "2000" });
    const channel = h.ctx.db.prepare("SELECT last_seq, last_cumulative_micros FROM channels WHERE tab_id = ?").get(tabId);
    expect(channel).toEqual({ last_seq: 2, last_cumulative_micros: 2_000 });
  });
});

describe("policy limits", () => {
  it("seller_not_allowed", async () => {
    const { agent } = await openTab(h, { allowedSellers: ["someone-else"] });
    expect((await agent.call(h.app, "acme", "GET", "/v1/q/ok")).reason).toBe("seller_not_allowed");
  });

  it("price_above_limit", async () => {
    const { agent } = await openTab(h, { perCallMaxMicros: 4_000 });
    expect((await agent.call(h.app, "acme", "POST", "/v1/search", { body: SEARCH_BODY })).reason).toBe("price_above_limit");
    expect((await agent.call(h.app, "acme", "GET", "/v1/products/p1")).status).toBe(200);
  });

  it("daily_cap_reached counts today's spend only (UTC day, demo clock)", async () => {
    const { agent } = await openTab(h, { dailyCapMicros: 6_000 });
    expect((await agent.call(h.app, "acme", "POST", "/v1/search", { body: SEARCH_BODY })).status).toBe(200);
    expect((await agent.call(h.app, "acme", "POST", "/v1/search", { body: SEARCH_BODY })).reason).toBe("daily_cap_reached");
    h.ctx.clock.advance(86_400_000);
    expect((await agent.call(h.app, "acme", "POST", "/v1/search", { body: SEARCH_BODY })).status).toBe(200);
  });

  it("hold_exhausted counts the carried-in remainder and in-flight (pending) calls", async () => {
    const { tabId, agent } = await openTab(h, { holdCents: 100 });
    h.ctx.db.prepare("UPDATE tabs SET carry_in_micros = 996000 WHERE id = ?").run(tabId);
    const one = agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/a", price: 2_000 });
    const two = agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/b", price: 2_000, seq: 2, cumulative: 4_000 });
    const three = agent.header({ sellerId: "acme", method: "GET", path: "/v1/products/c", price: 2_000, seq: 3, cumulative: 6_000 });
    const [r1, r2, r3] = await Promise.all(
      [
        ["a", one],
        ["b", two],
        ["c", three],
      ].map(([id, header]) => h.app.inject({ method: "GET", url: `/s/acme/v1/products/${id}`, headers: { [X402_HEADERS.signature]: header! } })),
    );
    expect(r1!.statusCode).toBe(200);
    expect(r2!.statusCode).toBe(200);
    expect((r3!.json() as PaymentRequired).accepts[0]?.extra.reason).toBe("hold_exhausted");
  });

  it("rate_limited counts in-flight calls and says when to retry", async () => {
    const { agent } = await openTab(h, { maxCallsPerMinute: 2 });
    const headers = [1, 2, 3].map((seq) =>
      agent.header({ sellerId: "acme", method: "GET", path: `/v1/q/ok${seq}`, price: 1_000, seq, cumulative: seq * 1_000 }),
    );
    const results = await Promise.all(
      headers.map((header, i) => h.app.inject({ method: "GET", url: `/s/acme/v1/q/ok${i + 1}`, headers: { [X402_HEADERS.signature]: header } })),
    );
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 402]);
    const extra = (results[2]!.json() as PaymentRequired).accepts[0]!.extra;
    expect(extra.reason).toBe("rate_limited");
    expect(extra.retryAfterSec).toBeGreaterThan(0);
    expect(results[2]!.headers["retry-after"]).toBe(String(extra.retryAfterSec));
  });
});

describe("quality guard through the paywall", () => {
  const cases: Array<[kase: string, status: number, verdict: "accepted" | "voided", reason?: string]> = [
    ["ok", 200, "accepted"],
    ["500", 500, "voided", "upstream_5xx"],
    ["404", 404, "voided", "upstream_4xx"],
    ["402", 402, "accepted"],
    ["empty", 200, "voided", "empty_result"],
    ["emptyarr", 200, "voided", "empty_result"],
    ["emptyobj", 200, "voided", "empty_result"],
    ["products-empty", 200, "voided", "empty_result"],
    ["products", 200, "accepted"],
    ["badjson", 200, "voided", "malformed_json"],
    ["text", 200, "accepted"],
    ["gzip", 200, "accepted"],
    ["slow", 504, "voided", "timeout"],
    ["reset", 502, "voided", "upstream_unreachable"],
    ["huge", 502, "voided", "upstream_unreachable"],
  ];

  it.each(cases)("%s -> HTTP %i, %s %s", async (kase, status, verdict, reason) => {
    const { agent } = await openTab(h);
    const r = await agent.call(h.app, "acme", "GET", `/v1/q/${kase}`);
    expect(r.status).toBe(status);
    expect(r.payment).toMatchObject({ status: verdict, amount: verdict === "accepted" ? "1000" : "0", ...(reason ? { reason } : {}) });
    const voucher = h.ctx.db.prepare("SELECT status, void_reason FROM vouchers WHERE id = ?").get(r.payment!.transaction);
    expect(voucher).toEqual({ status: verdict, void_reason: reason ?? null });
    if (kase === "gzip") expect(JSON.parse(r.body)).toEqual({ ok: true, zipped: true });
    if (kase === "500") expect(JSON.parse(r.body)).toEqual({ error: "boom" });
  });

  it("checks the endpoint's response schema", async () => {
    const { agent } = await openTab(h);
    expect((await agent.call(h.app, "acme", "GET", "/v1/strict")).payment?.status).toBe("accepted");
    expect((await agent.call(h.app, "acme", "GET", "/v1/strict?bad=1")).payment).toMatchObject({ status: "voided", reason: "schema_mismatch" });
  });

  it("never leaves pending vouchers behind and never exposes them", async () => {
    const { tabId, agent } = await openTab(h);
    await Promise.all([agent.call(h.app, "acme", "GET", "/v1/q/slow")]);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'pending'").get()).toEqual({ n: 0 });
    const list = await injectJson<VoucherDTO[]>(h.app, "GET", `/api/vouchers?tabId=${tabId}`);
    expect(list.body.map((v) => v.status)).toEqual(["voided"]);
  });
});
