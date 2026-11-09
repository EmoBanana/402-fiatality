import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { generateAgentKeyPair, requestHash } from "@p402/shared/node";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ChannelBook, matchPath, X402Client, X402Error, type X402ClientOptions } from "../src/x402Client";
import { FakePaywall, type FakeSeller, jsonReply } from "./fakePaywall";

const keys = generateAgentKeyPair();
const AGENT = "agent_test";
let fake: FakePaywall;
let tabCounter = 0;

function itemSeller(overrides: Partial<FakeSeller> = {}): FakeSeller {
  return {
    id: "data",
    endpoints: [
      { method: "GET", path: "/v1/items/:id", priceMicros: 2_500 },
      { method: "POST", path: "/v1/search", priceMicros: 5_000 },
    ],
    voidRules: { emptyResultPaths: ["items"] },
    upstream: ({ path }) => (path.startsWith("/v1/search") ? jsonReply({ items: [{ id: "a" }] }) : jsonReply({ id: path.split("?")[0]?.split("/").pop() })),
    ...overrides,
  };
}

function setup(sellers: FakeSeller[] = [itemSeller()], extra: Partial<Parameters<FakePaywall["reset"]>[0]> = {}): string {
  const tabId = `tab_client_${++tabCounter}`;
  fake.reset({ tabId, sellers, ...extra });
  fake.keys.set(AGENT, keys.publicKey);
  return tabId;
}

function client(tabId: string, opts: Partial<X402ClientOptions> = {}): X402Client {
  return new X402Client({
    gatewayUrl: fake.url,
    tabId,
    agentId: AGENT,
    privateKey: keys.privateKey,
    taskId: "task_1",
    channels: new ChannelBook(),
    ...opts,
  });
}

beforeAll(async () => {
  fake = await FakePaywall.start(4420, { tabId: "unused", sellers: [] });
});

afterAll(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.reset({ tabId: "unused", sellers: [] });
});

describe("X402Client", () => {
  it("pays on the first request when the catalog knows the price", async () => {
    const tabId = setup();
    const c = client(tabId);
    const first = await c.fetch(c.sellerUrl("data", "/v1/items/a1?expand=1"));
    expect(first.response.status).toBe(200);
    expect(await first.response.json()).toEqual({ id: "a1" });
    expect(first).toMatchObject({ costMicros: 2_500, priceMicros: 2_500, seq: 1, channelCumulativeMicros: 2_500, sellerId: "data", endpoint: "GET /v1/items/a1" });
    expect(first.payment).toMatchObject({ status: "accepted", amount: "2500", cumulative: "2500", transaction: "v_1" });

    const second = await c.fetch(c.sellerUrl("data", "/v1/search"), { method: "POST", body: { query: "x" } });
    expect(second.payment?.status).toBe("accepted");
    expect(second).toMatchObject({ seq: 2, channelCumulativeMicros: 7_500, costMicros: 5_000 });
    const paywall = fake.requests.filter((r) => r.url.startsWith("/s/"));
    expect(paywall.map((r) => [r.paid, r.status])).toEqual([
      [true, 200],
      [true, 200],
    ]);
    expect(fake.vouchers.map((v) => [v.seq, v.cumulativeMicros])).toEqual([
      [1, 2_500],
      [2, 7_500],
    ]);
    expect(fake.vouchers[0]).toMatchObject({ agent: AGENT, task: "task_1", reqHash: requestHash("GET", "/v1/items/a1?expand=1", "") });
    expect(fake.vouchers[1]?.reqHash).toBe(requestHash("POST", "/v1/search", JSON.stringify({ query: "x" })));
  });

  it("reads the 402 quote when the price is unknown, then pays", async () => {
    const tabId = setup([itemSeller({ listed: false })]);
    const c = client(tabId);
    const result = await c.fetch(c.sellerUrl("data", "/v1/items/b2"));
    expect(result.costMicros).toBe(2_500);
    expect(fake.requests.filter((r) => r.url.startsWith("/s/")).map((r) => [r.paid, r.status, r.reason])).toEqual([
      [false, 402, "payment_required"],
      [true, 200, undefined],
    ]);
  });

  it("resyncs from expectedSeq/expectedCumulative on stale_sequence", async () => {
    const tabId = setup();
    fake.channels.set("data", { seq: 7, cumulative: 40_000 });
    const c = client(tabId);
    const result = await c.fetch(c.sellerUrl("data", "/v1/items/c3"));
    expect(result).toMatchObject({ seq: 8, channelCumulativeMicros: 42_500, costMicros: 2_500 });
    await c.fetch(c.sellerUrl("data", "/v1/items/c4"));
    expect(c.channel("data")).toEqual({ seq: 9, cumulative: 45_000 });
    expect(fake.requests.filter((r) => r.reason === "stale_sequence")).toHaveLength(1);
  });

  it("shares channels across clients and serializes concurrent calls", async () => {
    const tabId = setup();
    const book = new ChannelBook();
    const a = client(tabId, { channels: book });
    const b = client(tabId, { channels: book });
    const calls = Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).fetch(a.sellerUrl("data", `/v1/items/p${i}`)));
    const results = await Promise.all(calls);
    expect(results.every((r) => r.payment?.status === "accepted")).toBe(true);
    expect(fake.requests.filter((r) => r.status === 402)).toHaveLength(0);
    expect(fake.vouchers.map((v) => v.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(book.get(`${fake.url}|${tabId}|data`)).toEqual({ seq: 10, cumulative: 25_000 });
  });

  it("waits while the tab is paused, then retries", async () => {
    const tabId = setup(undefined, { retryAfterSec: 2 });
    fake.status = "paused";
    const waits: number[] = [];
    const paused: string[] = [];
    const c = client(tabId, {
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length === 2) fake.status = "active";
      },
      onPaused: (info) => paused.push(`${info.attempt}:${info.message}`),
    });
    const result = await c.fetch(c.sellerUrl("data", "/v1/items/d4"));
    expect(result.payment?.status).toBe("accepted");
    expect(result.waitedMs).toBe(4_000);
    expect(waits).toEqual([2_000, 2_000]);
    expect(paused).toEqual(["1:Tab paused: repeat_request alarm, AI review running", "2:Tab paused: repeat_request alarm, AI review running"]);
    expect(result.seq).toBe(1);
  });

  it("gives up with paused_timeout after the bounded wait", async () => {
    const tabId = setup(undefined, { retryAfterSec: 5 });
    fake.status = "paused";
    const c = client(tabId, { sleep: async () => {}, maxPauseWaitMs: 12_000 });
    const err = await c.fetch(c.sellerUrl("data", "/v1/items/e5")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402Error);
    expect(err).toMatchObject({ reason: "paused_timeout", scope: "tab" });
    expect(fake.requests.filter((r) => r.reason === "tab_paused")).toHaveLength(3);
  });

  it("can be aborted while waiting on a paused tab", async () => {
    const tabId = setup(undefined, { retryAfterSec: 10 });
    fake.status = "paused";
    const controller = new AbortController();
    const c = client(tabId, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(c.fetch(c.sellerUrl("data", "/v1/items/f6"))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("voided calls cost nothing but still advance the channel", async () => {
    const tabId = setup([itemSeller({ upstream: () => jsonReply({ error: "boom" }, 500) })]);
    const c = client(tabId);
    const first = await c.fetch(c.sellerUrl("data", "/v1/items/g7"));
    expect(first.response.status).toBe(500);
    expect(first.payment).toMatchObject({ status: "voided", amount: "0", reason: "upstream_5xx" });
    expect(first.costMicros).toBe(0);
    const second = await c.fetch(c.sellerUrl("data", "/v1/search"), { method: "POST", body: { query: "y" } });
    expect(second).toMatchObject({ seq: 2, channelCumulativeMicros: 7_500, costMicros: 0 });
  });

  it("stops on tab_frozen without retrying", async () => {
    const tabId = setup();
    fake.status = "frozen";
    const c = client(tabId);
    const err = await c.fetch(c.sellerUrl("data", "/v1/items/h8")).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "X402Error", reason: "tab_frozen", scope: "tab", message: "Tab frozen by AI review" });
    expect(fake.requests.filter((r) => r.url.startsWith("/s/"))).toHaveLength(1);
  });

  it("reprices once on amount_mismatch", async () => {
    const tabId = setup([
      itemSeller({ endpoints: [{ method: "GET", path: "/v1/items/:id", priceMicros: 3_000, listedPriceMicros: 2_500 }] }),
    ]);
    const c = client(tabId);
    const first = await c.fetch(c.sellerUrl("data", "/v1/items/i9"));
    expect(first).toMatchObject({ costMicros: 3_000, seq: 1 });
    await c.fetch(c.sellerUrl("data", "/v1/items/i10"));
    expect(fake.requests.filter((r) => r.reason === "amount_mismatch")).toHaveLength(1);
    expect(fake.vouchers.map((v) => v.cumulativeMicros)).toEqual([3_000, 6_000]);
  });

  it("adopts the gateway's demo clock after voucher_expired", async () => {
    const tabId = setup(undefined, { clockOffsetMs: 3 * 86_400_000 });
    const c = client(tabId);
    const first = await c.fetch(c.sellerUrl("data", "/v1/items/k1"));
    expect(first.payment?.status).toBe("accepted");
    await c.fetch(c.sellerUrl("data", "/v1/items/k2"));
    expect(fake.requests.filter((r) => r.reason === "voucher_expired")).toHaveLength(1);
    expect(fake.vouchers.map((v) => v.seq)).toEqual([1, 2]);
  });

  it("sends api headers to /api only, never to the paywall", async () => {
    const tabId = setup();
    const c = client(tabId, { apiHeaders: { "x-p402-admin": "admin-secret" } });
    await c.fetch(c.sellerUrl("data", "/v1/items/j1"));
    const api = fake.requests.filter((r) => r.url.startsWith("/api/"));
    const paywall = fake.requests.filter((r) => r.url.startsWith("/s/"));
    expect(api.length).toBeGreaterThan(0);
    expect(api.every((r) => r.adminHeader)).toBe(true);
    expect(paywall.some((r) => r.adminHeader)).toBe(false);
  });

  it("never signs or sends a voucher to another origin", async () => {
    const seen: Array<string | undefined> = [];
    const other = createServer((req, res) => {
      seen.push(req.headers["payment-signature"] as string | undefined);
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    try {
      const c = client(setup());
      const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}/s/data/v1/items/a1`;
      await expect(c.fetch(url)).rejects.toMatchObject({ reason: "not_paywall_url" });
      expect(seen).toEqual([]);
      expect(c.channel("data")).toEqual({ seq: 0, cumulative: 0 });
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  it("rejects URLs outside the paywall and matches path patterns", async () => {
    const c = client(setup());
    await expect(c.fetch(`${fake.url}/api/catalog`)).rejects.toMatchObject({ reason: "not_paywall_url" });
    expect(matchPath("/v1/products/:id", "/v1/products/esp-1001")).toBe(true);
    expect(matchPath("/v1/products/:id", "/v1/products/")).toBe(false);
    expect(matchPath("/v1/search", "/v1/search/x")).toBe(false);
  });
});
