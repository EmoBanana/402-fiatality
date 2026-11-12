/**
 * Per-IP limits on the routes that spend money or model time: PayPal calls, the LLM and in-process agent runs.
 * One table, matched by method + route pattern, so route files stay as they are. Sized for a judge clicking around
 * the public demo, not for a script: past the limit the route answers 429 `rate_limited` with Retry-After.
 * Requests from this machine that no proxy forwarded are exempt (the Vite dev proxy, tests, local scripts).
 * Every /api route also keeps server.ts's generous global limit; the paywall has per-tab policy limits instead.
 */
import { BlockList, isIP } from "node:net";
import { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from "fastify";
import { AppError, type AppConfig } from "../context";
import { routePath } from "./guards";

export type LimitGroup = "paypal" | "ai" | "chat" | "agent";

/** "METHOD /route/pattern" -> its group. Param names don't matter (`:id` and `:purchaseId` compare equal). */
export const LIMITED_ROUTES: Readonly<Record<string, LimitGroup>> = {
  // PayPal: holds, charges, checkouts, refunds, payouts and disputes. The demo clock's tick reauthorizes and charges.
  "POST /api/tabs": "paypal",
  "POST /api/tabs/:id/close": "paypal",
  "POST /api/purchases/:id/checkout": "paypal",
  "POST /api/purchases/:id/refund": "paypal",
  "POST /api/payouts/run": "paypal",
  "POST /api/disputes/sync": "paypal",
  "POST /api/disputes/mock": "paypal",
  "POST /api/disputes/:id/actions": "paypal",
  "POST /api/disputes/:id/adjudicate": "paypal",
  "POST /api/clock/advance": "paypal",
  // The LLM.
  "POST /api/policy/parse": "ai",
  "POST /api/ai/grid-query": "ai",
  "POST /api/disputes/:id/jury": "ai",
  // AG Studio's assistant: one question can take several model turns, so it gets a bucket of its own.
  "POST /api/ai/chat": "chat",
  // In-process agents: model steps plus paid seller calls (the real Channel3 API when CHANNEL3_API_KEY is set).
  "POST /api/agent/runs": "agent",
};

const MINUTE_MS = 60_000;

interface GroupLimit {
  max: number;
  windowMs: number;
  /** "Too many <what> from your network". */
  what: string;
}

function groupLimits(limits: AppConfig["rateLimits"]): Record<LimitGroup, GroupLimit> {
  return {
    paypal: { max: limits.paypalPerMinute, windowMs: MINUTE_MS, what: "PayPal requests" },
    ai: { max: limits.aiPerMinute, windowMs: MINUTE_MS, what: "AI requests" },
    chat: { max: limits.aiPerMinute, windowMs: MINUTE_MS, what: "AI assistant requests" },
    agent: { max: limits.agentRunsPer10Minutes, windowMs: 10 * MINUTE_MS, what: "agent runs" },
  };
}

/** "/api/tabs/:tabId/close" -> "/api/tabs/:/close". */
const shape = (route: string) => route.replace(/\/:[^/]+/g, "/:");

const GROUP_OF = new Map(Object.entries(LIMITED_ROUTES).map(([route, group]) => [shape(route), group]));

function limitGroupOf(request: FastifyRequest): LimitGroup | undefined {
  return GROUP_OF.get(shape(`${request.method} ${routePath(request)}`));
}

const FORWARDED_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip"] as const;

/** From this machine and not forwarded by a proxy (Vite's dev proxy adds no X-Forwarded-For). */
function isLocalRequest(request: FastifyRequest): boolean {
  const peer = request.socket?.remoteAddress ?? "";
  const loopback = peer === "::1" || /^(::ffff:)?127\./.test(peer);
  return loopback && FORWARDED_HEADERS.every((header) => request.headers[header] === undefined);
}

/** The bucket key: the client IP, or an IPv6 client's /64 (one home or server usually holds the whole block). */
function clientKey(request: FastifyRequest): string {
  const ip = request.ip || request.socket?.remoteAddress;
  return ip ? normalizeIP(ip) : "unknown";
}

/**
 * The onRequest hook enforcing LIMITED_ROUTES (register it after @fastify/rate-limit, whose store it shares).
 * A request is counted before its body is parsed; a group with max 0 is off.
 */
export function expensiveRouteLimits(app: FastifyInstance, limits: AppConfig["rateLimits"]): onRequestHookHandler {
  const groups = groupLimits(limits);
  const checks = new Map<LimitGroup, ReturnType<FastifyInstance["createRateLimit"]>>();
  for (const [group, { max, windowMs }] of Object.entries(groups) as Array<[LimitGroup, GroupLimit]>) {
    if (max > 0) checks.set(group, app.createRateLimit({ max, timeWindow: windowMs, keyGenerator: clientKey, allowList: isLocalRequest }));
  }

  return async (request, reply) => {
    const group = limitGroupOf(request);
    const check = group && checks.get(group);
    if (!group || !check) return;
    const result = await check(request);
    if (result.isAllowed || !result.isExceeded) return;
    const { what, windowMs } = groups[group];
    const minutes = windowMs / MINUTE_MS;
    void reply.header("retry-after", String(result.ttlInSeconds));
    throw new AppError(
      429,
      "rate_limited",
      `Too many ${what} from your network (${result.max} per ${minutes === 1 ? "minute" : `${minutes} minutes`}). ` +
        `Try again in ${result.ttlInSeconds} s.`,
      { group, limit: result.max, windowSeconds: windowMs / 1000, retryAfterSeconds: result.ttlInSeconds },
    );
  };
}

const privateNetworks = new BlockList();
for (const [net, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["100.64.0.0", 10], // carrier-grade NAT, used by some platforms' internal networks
  ["127.0.0.0", 8],
] as const) {
  privateNetworks.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) {
  privateNetworks.addSubnet(net, prefix, "ipv6");
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && privateNetworks.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * Fastify `trustProxy` for `hops` reverse proxies. Fastify 5.12 ignores a bare hop count because it can't vet the
 * immediate peer, so the peer must be on a private network, as Render's load balancer is (10.x). Behind it,
 * X-Forwarded-For reads "<client>, <Cloudflare edge>": 2 hops make request.ip the client, and entries a client
 * sends itself sit further left, where they are never trusted.
 */
export function trustProxyHops(hops: number): (address: string, hop: number) => boolean {
  return (address, hop) => hop < hops && (hop > 0 || isPrivateAddress(address));
}
