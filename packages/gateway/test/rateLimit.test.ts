import type { LightMyRequestResponse } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { LIMITED_ROUTES, trustProxyHops } from "../src/http/rateLimit";
import { createHarness, type Harness } from "./helpers";

let h: Harness;
afterEach(async () => {
  await h?.close();
});

const LIMITS = { paypalPerMinute: 2, aiPerMinute: 2, agentRunsPer10Minutes: 1 };

interface From {
  /** Socket address (default: a public client). */
  peer?: string;
  forwardedFor?: string;
}

function post(url: string, body: unknown, from: From = {}): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url,
    remoteAddress: from.peer ?? "203.0.113.7",
    headers: { "content-type": "application/json", ...(from.forwardedFor ? { "x-forwarded-for": from.forwardedFor } : {}) },
    payload: JSON.stringify(body),
  });
}

const parsePolicy = (from?: From) => post("/api/policy/parse", { text: "$5 a day, only channel3" }, from);

describe("per-IP limits on routes that call PayPal, the LLM or start agents", () => {
  it("answers 429 rate_limited past the limit, per client and per group", async () => {
    h = await createHarness({ withSeller: false, config: { rateLimits: LIMITS } });
    expect((await parsePolicy()).statusCode).toBe(200);
    expect((await parsePolicy()).statusCode).toBe(200);
    const limited = await parsePolicy();
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: "rate_limited", details: { group: "ai", limit: 2, windowSeconds: 60 } });
    expect(limited.json().message).toMatch(/^Too many AI requests from your network \(2 per minute\)\. Try again in \d+ s\.$/);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((await post("/api/ai/grid-query", { question: "voids", schema: {}, state: {} })).statusCode).toBe(429);

    // Another client, or another group, has its own bucket.
    expect((await parsePolicy({ peer: "198.51.100.20" })).statusCode).toBe(200);
    expect((await post("/api/ai/chat", { messages: [{ role: "user", content: "hi" }] })).statusCode).toBe(200);
    expect((await post("/api/tabs/tab_a/close", {})).statusCode).not.toBe(429);
    expect((await post("/api/tabs/tab_b/close", {})).statusCode).not.toBe(429);
    expect((await post("/api/tabs/tab_c/close", {})).statusCode).toBe(429);

    // An IPv6 client is one /64.
    expect((await parsePolicy({ peer: "2001:db8:1:2::1" })).statusCode).toBe(200);
    expect((await parsePolicy({ peer: "2001:db8:1:2::99" })).statusCode).toBe(200);
    expect((await parsePolicy({ peer: "2001:db8:1:2:ffff::7" })).statusCode).toBe(429);
  });

  it("caps agent runs per 10 minutes", async () => {
    h = await createHarness({ withSeller: false, config: { rateLimits: LIMITS } });
    const run = { tabId: "tab_nope", task: "Find an espresso machine", mode: "scripted" };
    expect((await post("/api/agent/runs", run)).statusCode).toBe(404);
    const limited = await post("/api/agent/runs", run);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().message).toMatch(/^Too many agent runs from your network \(1 per 10 minutes\)/);
  });

  it("exempts this machine unless a proxy forwarded the request", async () => {
    h = await createHarness({ withSeller: false, config: { rateLimits: LIMITS } });
    for (let i = 0; i < 6; i++) {
      expect((await parsePolicy({ peer: "127.0.0.1" })).statusCode).toBe(200);
      expect((await parsePolicy({ peer: "::1" })).statusCode).toBe(200);
    }
    const proxied = { peer: "127.0.0.1", forwardedFor: "198.51.100.30" };
    expect((await parsePolicy(proxied)).statusCode).toBe(200);
    expect((await parsePolicy(proxied)).statusCode).toBe(200);
    expect((await parsePolicy(proxied)).statusCode).toBe(429);
  });

  it("leaves every other route alone", async () => {
    h = await createHarness({ config: { rateLimits: LIMITS } });
    for (let i = 0; i < 5; i++) {
      expect((await post("/api/companies", { name: `Co ${i}` })).statusCode).toBe(201);
      expect((await h.app.inject({ method: "GET", url: "/api/catalog", remoteAddress: "203.0.113.7" })).statusCode).toBe(200);
      expect((await h.app.inject({ method: "GET", url: "/api/health", remoteAddress: "203.0.113.7" })).statusCode).toBe(200);
      expect((await h.app.inject({ method: "GET", url: "/s/acme/v1/q/ok", remoteAddress: "203.0.113.7" })).statusCode).toBe(402);
    }
  });

  it("can be turned off per group", async () => {
    h = await createHarness({ withSeller: false, config: { rateLimits: { ...LIMITS, aiPerMinute: 0 } } });
    for (let i = 0; i < 5; i++) expect((await parsePolicy()).statusCode).toBe(200);
  });

  it("names routes the gateway serves", async () => {
    h = await createHarness({ withSeller: false });
    // POST /api/purchases/:id/refund lands in its own change; every other entry must match a route.
    const missing = Object.keys(LIMITED_ROUTES).filter((route) => {
      const [method, url] = route.split(" ") as ["POST", string];
      return !h.app.hasRoute({ method, url });
    });
    expect(missing.filter((route) => route !== "POST /api/purchases/:id/refund")).toEqual([]);
  });
});

describe("client IP behind proxies", () => {
  it("trusts the configured hops only behind a private-network peer", () => {
    const trust = trustProxyHops(2);
    expect(trust("10.21.157.68", 0)).toBe(true);
    expect(trust("::ffff:10.1.2.3", 0)).toBe(true);
    expect(trust("203.0.113.9", 0)).toBe(false);
    expect(trust("104.22.17.40", 1)).toBe(true);
    expect(trust("99.61.165.29", 2)).toBe(false);
  });

  it("keys Render traffic by the client in X-Forwarded-For, which a client can't spoof", async () => {
    h = await createHarness({ withSeller: false, config: { trustProxyHops: 2, rateLimits: LIMITS } });
    // Render's load balancer (10.x) appends the Cloudflare edge it got the request from; Cloudflare appended the client.
    const client = { peer: "10.21.157.68", forwardedFor: "198.51.100.40, 104.22.17.40" };
    expect((await parsePolicy(client)).statusCode).toBe(200);
    expect((await parsePolicy(client)).statusCode).toBe(200);
    expect((await parsePolicy({ ...client, forwardedFor: `6.6.6.6, ${client.forwardedFor}` })).statusCode).toBe(429);
    expect((await parsePolicy({ ...client, forwardedFor: "198.51.100.41, 104.22.17.40" })).statusCode).toBe(200);
    // A public peer is not a proxy: its header is ignored.
    const direct = { peer: "203.0.113.8", forwardedFor: "198.51.100.50, 104.22.17.40" };
    expect((await parsePolicy(direct)).statusCode).toBe(200);
    expect((await parsePolicy({ ...direct, forwardedFor: "198.51.100.51, 104.22.17.40" })).statusCode).toBe(200);
    expect((await parsePolicy({ ...direct, forwardedFor: "198.51.100.52, 104.22.17.40" })).statusCode).toBe(429);
  });

  it("ignores X-Forwarded-For when no proxy is trusted (the default off Render)", async () => {
    h = await createHarness({ withSeller: false, config: { rateLimits: LIMITS } });
    const peer = "10.21.157.68";
    expect((await parsePolicy({ peer, forwardedFor: "198.51.100.60" })).statusCode).toBe(200);
    expect((await parsePolicy({ peer, forwardedFor: "198.51.100.61" })).statusCode).toBe(200);
    expect((await parsePolicy({ peer, forwardedFor: "198.51.100.62" })).statusCode).toBe(429);
  });
});

describe("Render configuration", () => {
  it("falls back to RENDER_EXTERNAL_URL and trusts Render's two proxies", () => {
    const render = { NODE_ENV: "production", RENDER: "true", RENDER_EXTERNAL_URL: "https://fiatality.onrender.com/" } as const;
    expect(loadConfig(render)).toMatchObject({
      publicBaseUrl: "https://fiatality.onrender.com",
      webBaseUrl: "https://fiatality.onrender.com",
      trustProxyHops: 2,
    });
    const custom = loadConfig({ ...render, PUBLIC_BASE_URL: "https://demo.example.com", TRUST_PROXY_HOPS: "0" });
    expect(custom).toMatchObject({ publicBaseUrl: "https://demo.example.com", webBaseUrl: "https://demo.example.com", trustProxyHops: 0 });
    expect(loadConfig({ RENDER_EXTERNAL_URL: "not a url" }).publicBaseUrl).toBe("http://localhost:4020");
  });

  it("keeps local defaults: Vite's origin in dev, the gateway's own when it serves the app", () => {
    expect(loadConfig({})).toMatchObject({
      publicBaseUrl: "http://localhost:4020",
      webBaseUrl: "http://localhost:5173",
      trustProxyHops: 0,
      rateLimits: { paypalPerMinute: 30, aiPerMinute: 30, agentRunsPer10Minutes: 10 },
    });
    expect(loadConfig({ NODE_ENV: "production", PORT: "10000" }).webBaseUrl).toBe("http://localhost:10000");
    expect(loadConfig({ RATE_LIMIT_AI_PER_MINUTE: "0", RATE_LIMIT_AGENT_RUNS_PER_10_MINUTES: "3" }).rateLimits).toMatchObject({
      aiPerMinute: 0,
      agentRunsPer10Minutes: 3,
    });
  });
});
