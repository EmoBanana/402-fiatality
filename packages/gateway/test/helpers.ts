/**
 * Test harness: an offline gateway (in-memory SQLite, demo mode) with small fakes for the services other
 * builders implement (settlement, AI, agents), a fake seller API on a real local port, and a test agent that
 * signs x402 vouchers exactly like the buyer agent does.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_POLICY,
  newId,
  normalizePolicy,
  X402_HEADERS,
  type AlarmRules,
  type PaymentPayload,
  type PaymentRequired,
  type Policy,
  type PolicyParseDTO,
  type SellerCreateDTO,
  type SettlementDTO,
  type SettlementResponse,
  type TabCreatedDTO,
  type Voucher,
} from "@p402/shared";
import { decodeX402Header, encodeX402Header, generateAgentKeyPair, randomNonce, requestHash, signVoucher } from "@p402/shared/node";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import {
  createTestContext,
  type AiService,
  type AppConfig,
  type AppContext,
  type CloseReason,
  type ContextOverrides,
  type RunAgent,
  type SettlementService,
  type SpendReviewInput,
  type SpendReviewResult,
} from "../src/context";
import { coreOf } from "../src/core";
import { getTabDTO } from "../src/db/dto";
import { registerSeller } from "../src/sellers/registry";
import { buildServer, type BuildServerOptions } from "../src/server";

// ------------------------------------------------------------------ fake seller

export interface SellerRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface FakeSeller {
  url: string;
  requests: SellerRequest[];
  close(): Promise<void>;
}

const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof value === "string" ? value : JSON.stringify(value));
};

/** Behaviors keyed by the last path segment of GET|POST /v1/q/:case. */
function respond(kase: string, req: SellerRequest, res: ServerResponse): void {
  switch (kase) {
    case "ok":
      return json(res, 200, { ok: true, items: [1, 2, 3] });
    case "500":
      return json(res, 500, { error: "boom" });
    case "404":
      return json(res, 404, { error: "no such thing" });
    case "402":
      return json(res, 402, { error: "pay me" });
    case "empty":
      return json(res, 200, "");
    case "emptyarr":
      return json(res, 200, []);
    case "emptyobj":
      return json(res, 200, {});
    case "products-empty":
      return json(res, 200, { products: [], next_page_token: null });
    case "products":
      return json(res, 200, { products: [{ id: "p1" }] });
    case "badjson":
      return json(res, 200, '{"products": [');
    case "text":
      res.writeHead(200, { "content-type": "text/plain" });
      return void res.end("plain words");
    case "slow":
      setTimeout(() => json(res, 200, { ok: true, slow: true }), 1_500).unref();
      return;
    case "huge":
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(`["${"x".repeat(3 * 1024 * 1024)}"]`);
    case "gzip":
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
      return void res.end(gzipSync(JSON.stringify({ ok: true, zipped: true })));
    case "echo":
      return json(res, 200, { method: req.method, url: req.url, headers: req.headers, body: req.body });
    case "reset":
      return void res.socket?.destroy();
    default:
      return json(res, 200, { ok: true, kase });
  }
}

export async function startFakeSeller(): Promise<FakeSeller> {
  const requests: SellerRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const r: SellerRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(r);
      const path = (r.url.split("?")[0] ?? "").replace(/^\/acme/, "");
      const q = /^\/v1\/q\/([^/]+)$/.exec(path);
      if (q?.[1]) return respond(q[1], r, res);
      if (path === "/v1/search") return json(res, 200, { products: [{ id: "p1", title: "Espresso machine" }], query: r.body });
      if (path.startsWith("/v1/products/")) return json(res, 200, { id: path.split("/").pop(), title: "Espresso machine" });
      if (path === "/v1/strict") return json(res, 200, r.url.includes("bad") ? { name: 42 } : { id: "s1", name: "strict" });
      json(res, 404, { error: "unknown fake route" });
    });
  });
  server.keepAliveTimeout = 100;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export const ACME_API_KEY = "acme-secret-key-123";

export function acmeListing(baseUrl: string, overrides: Partial<SellerCreateDTO> = {}): SellerCreateDTO {
  return {
    id: "acme",
    name: "Acme Data",
    baseUrl: `${baseUrl}/acme`,
    authHeader: "x-api-key",
    apiKey: ACME_API_KEY,
    paypalEmail: "acme@example.com",
    voidRules: { timeoutMs: 400, emptyResultPaths: ["products"] },
    endpoints: [
      { method: "POST", path: "/v1/search", priceMicros: 5_000, description: "Search products" },
      { method: "GET", path: "/v1/products/:id", priceMicros: 2_000 },
      { method: "GET", path: "/v1/q/:case", priceMicros: 1_000 },
      { method: "POST", path: "/v1/q/:case", priceMicros: 1_000 },
      {
        method: "GET",
        path: "/v1/strict",
        priceMicros: 3_000,
        responseSchema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
      },
    ],
    ...overrides,
  };
}

// ------------------------------------------------------------------ fake services

export const ENROLL_TOKENS = new Map<string, string>();

export interface FakeSettlement extends SettlementService {
  closed: Array<{ tabId: string; reason: CloseReason }>;
  ticks: number;
  /** Simulates the PayPal approval + authorization (paypal-builder's /paypal/return does this for real). */
  approve(tabId: string): void;
}

export function fakeSettlement(ctx: AppContext): FakeSettlement {
  const closed: FakeSettlement["closed"] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error("not part of the gateway-core fake");
  };
  const fake: FakeSettlement = {
    closed,
    ticks: 0,
    async createHold(input): Promise<TabCreatedDTO> {
      const id = newId("tab");
      const enrollToken = randomBytes(24).toString("base64url");
      ENROLL_TOKENS.set(id, enrollToken);
      const orderId = `ORDER-${id}`;
      const approveUrl = `http://localhost:4020/paypal/mock/approve?token=${orderId}`;
      ctx.db
        .prepare(
          `INSERT INTO tabs (id, company_id, label, status, policy, policy_text, hold_cents, enroll_token_hash, paypal_order_id, approve_url, created_at)
           VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.companyId,
          input.label ?? null,
          JSON.stringify(input.policy),
          input.policyText ?? null,
          input.policy.holdCents,
          createHash("sha256").update(enrollToken).digest("hex"),
          orderId,
          approveUrl,
          ctx.clock.now(),
        );
      return { tab: getTabDTO(ctx.db, id, ctx.clock.now())!, enrollToken, orderId, approveUrl };
    },
    async closeTab(tabId, reason): Promise<SettlementDTO> {
      closed.push({ tabId, reason });
      ctx.db.prepare("UPDATE tabs SET status = 'settled', closed_at = ? WHERE id = ?").run(ctx.clock.now(), tabId);
      return { id: `stl_${tabId}`, tabId, status: "completed" } as SettlementDTO;
    },
    async tick() {
      fake.ticks += 1;
    },
    runPayouts: unsupported,
    proposePurchase: unsupported,
    checkoutPurchase: unsupported,
    statement: unsupported,
    start() {},
    stop() {},
    approve(tabId) {
      const now = ctx.clock.now();
      ctx.db
        .prepare("UPDATE tabs SET status = 'active', authorization_id = ?, authorized_at = ?, honor_until = ? WHERE id = ?")
        .run(`AUTH-${tabId}`, now, now + 3 * 86_400_000, tabId);
    },
  };
  return fake;
}

export type ReviewScript = (input: SpendReviewInput) => Partial<SpendReviewResult> | Promise<Partial<SpendReviewResult>>;

export interface FakeAi extends AiService {
  reviews: SpendReviewInput[];
  /** What the judge decides; default: freeze with high confidence (agent fault). */
  script: ReviewScript;
}

export function fakeAi(): FakeAi {
  const ai: FakeAi = {
    reviews: [],
    script: () => ({ verdict: "freeze", fault: "agent", confidence: 0.92, reason: "Needless repeated calls." }),
    llm: {
      provider: "mock",
      model: "fake-gemma",
      chat: async () => "ok",
      json: async () => {
        throw new Error("unused");
      },
      health: async () => ({ reachable: true, model: "fake-gemma" }),
    },
    async parsePolicy(text, catalog): Promise<PolicyParseDTO> {
      return { policy: DEFAULT_POLICY, summary: [`Parsed "${text}" against ${catalog.length} seller(s)`], model: "fake-gemma" };
    },
    async reviewSpend(input, onMessage) {
      ai.reviews.push(input);
      const at = Date.now();
      onMessage({ role: "prosecutor", content: `Wasteful: ${input.vouchers.length} calls`, at });
      onMessage({ role: "defender", content: "The task needed data.", at });
      const decided = await ai.script(input);
      onMessage({ role: "judge", content: decided.reason ?? "decided", at });
      return {
        verdict: "resume",
        fault: "none",
        confidence: 0.9,
        reason: "ok",
        voidVoucherIds: [],
        transcript: [],
        model: "fake-gemma",
        ...decided,
      };
    },
    async reviewDispute(input, onMessage) {
      const at = Date.now();
      onMessage({ role: "prosecutor", content: `The buyer disputes ${input.amountCents} cents.`, at });
      onMessage({ role: "defender", content: `${input.signatures.verified} of ${input.signatures.billedCalls} calls are signed.`, at });
      onMessage({ role: "judge", content: "Contest the dispute.", at });
      return { recommendation: "contest", refundCents: 0, confidence: 0.9, reason: "Signed calls.", draft: "The buyer's agents signed every call.", transcript: [], model: "fake-gemma" };
    },
    async gridQuery(request) {
      return { state: { ...request.state, filter: { q: request.question } }, explanation: "filtered", model: "fake-gemma" };
    },
    async chatProxy(request) {
      return {
        id: "chat_1",
        object: "chat.completion",
        created: 1,
        model: "fake-gemma",
        choices: [{ index: 0, message: { role: "assistant", content: `echo: ${request.messages.at(-1)?.content ?? ""}` }, finish_reason: "stop" }],
      };
    },
  };
  return ai;
}

// ------------------------------------------------------------------ harness

export interface Harness {
  ctx: AppContext;
  app: FastifyInstance;
  seller: FakeSeller;
  settlement: FakeSettlement;
  ai: FakeAi;
  /** Wait for alarm detection, threshold closes and reviews to settle. */
  idle(): Promise<void>;
  close(): Promise<void>;
}

export interface HarnessOptions extends BuildServerOptions {
  config?: Partial<AppConfig>;
  runAgent?: RunAgent;
  realNow?: () => number;
  demoSellers?: ContextOverrides["demoSellers"];
  /** Register the "acme" fake seller (default true). */
  withSeller?: boolean;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const seller = await startFakeSeller();
  const ai = fakeAi();
  let settlement!: FakeSettlement;
  const ctx = createTestContext({
    config: opts.config,
    realNow: opts.realNow,
    runAgent: opts.runAgent,
    demoSellers: opts.demoSellers,
    ai,
    settlement: (c) => (settlement = fakeSettlement(c)),
  });
  const app = await buildServer(ctx, { reviewTimeoutMs: 2_000, ...opts });
  await app.ready();
  if (opts.withSeller !== false) await registerSeller(ctx, acmeListing(seller.url));
  return {
    ctx,
    app,
    seller,
    settlement,
    ai,
    idle: () => coreOf(ctx).idle(),
    async close() {
      await app.close(); // aborts running agents and reviews
      await Promise.race([coreOf(ctx).agents.idle(), sleep(2_000)]);
      await seller.close();
      ctx.db.close();
    },
  };
}

export async function injectJson<T = unknown>(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T; res: LightMyRequestResponse }> {
  const res = await app.inject({
    method,
    url,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    payload: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.statusCode, body: (res.body ? JSON.parse(res.body) : undefined) as T, res };
}

export interface PolicyOverrides extends Partial<Omit<Policy, "alarms">> {
  alarms?: Partial<AlarmRules>;
}

/** Company + tab (approved) through the REST API, with one enrolled test agent. */
export async function openTab(h: Harness, policy: PolicyOverrides = {}): Promise<{ tabId: string; agent: TestAgent }> {
  const company = await injectJson<{ id: string }>(h.app, "POST", "/api/companies", { name: `Co ${randomBytes(3).toString("hex")}` });
  const created = await injectJson<TabCreatedDTO>(h.app, "POST", "/api/tabs", {
    companyId: company.body.id,
    policy: normalizePolicy(policy as Parameters<typeof normalizePolicy>[0]),
  });
  if (created.status !== 201) throw new Error(`tab creation failed: ${JSON.stringify(created.body)}`);
  const tabId = created.body.tab.id;
  h.settlement.approve(tabId);
  const agent = new TestAgent(tabId, `agent_${randomBytes(3).toString("hex")}`, h.ctx);
  const enrolled = await injectJson(h.app, "POST", `/api/tabs/${tabId}/keys`, {
    agentId: agent.agentId,
    publicKey: agent.keys.publicKey,
    enrollToken: created.body.enrollToken,
  });
  if (enrolled.status !== 200) throw new Error(`enroll failed: ${JSON.stringify(enrolled.body)}`);
  return { tabId, agent };
}

// ------------------------------------------------------------------ test agent

export interface SignOptions {
  sellerId: string;
  method: string;
  path: string;
  body?: string;
  price: number;
  seq?: number;
  cumulative?: number;
  /** Real-time seconds; default now from the harness clock's real time. */
  iat?: number;
  exp?: number;
  voucher?: Partial<Voucher> & Record<string, unknown>;
  accepted?: Partial<PaymentPayload["accepted"]>;
  privateKey?: string;
  agentId?: string | null;
}

export interface PaidResult {
  status: number;
  body: string;
  res: LightMyRequestResponse;
  required: PaymentRequired | null;
  payment: SettlementResponse | null;
  reason: string | undefined;
}

export class TestAgent {
  readonly keys = generateAgentKeyPair();
  private readonly seqs = new Map<string, { seq: number; cumulative: number }>();

  constructor(
    readonly tabId: string,
    readonly agentId: string,
    private readonly ctx: AppContext,
  ) {}

  nowSec(): number {
    return Math.floor((this.ctx.clock.now() - this.ctx.clock.offsetMs()) / 1000);
  }

  channel(sellerId: string): { seq: number; cumulative: number } {
    return this.seqs.get(sellerId) ?? { seq: 0, cumulative: 0 };
  }

  header(o: SignOptions): string {
    const last = this.channel(o.sellerId);
    const iat = o.iat ?? this.nowSec();
    const voucher = {
      v: 1,
      tab: this.tabId,
      seller: o.sellerId,
      seq: o.seq ?? last.seq + 1,
      price: String(o.price),
      cumulative: String(o.cumulative ?? last.cumulative + o.price),
      reqHash: requestHash(o.method, o.path, o.body ?? ""),
      ...(o.agentId === null ? {} : { agent: o.agentId ?? this.agentId }),
      task: "test-task",
      iat,
      exp: o.exp ?? iat + 120,
      nonce: randomNonce(),
      ...o.voucher,
    } as Voucher;
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: { url: `http://localhost:4020/s/${o.sellerId}${o.path}` },
      accepted: {
        scheme: "batch-settlement",
        network: "paypal:mock",
        asset: "USD",
        amount: String(o.price),
        payTo: o.sellerId,
        maxTimeoutSeconds: 300,
        extra: { decimals: 6, endpointId: "", tabEndpoint: "", catalogUrl: "", voidRules: {} as never },
        ...o.accepted,
      } as PaymentPayload["accepted"],
      payload: signVoucher(voucher, o.privateKey ?? this.keys.privateKey),
    };
    return encodeX402Header(payload);
  }

  /** Pay for one call through app.inject; tracks seq/cumulative like the real client (402 = nothing recorded). */
  async call(
    app: FastifyInstance,
    sellerId: string,
    method: "GET" | "POST",
    path: string,
    opts: Omit<SignOptions, "sellerId" | "method" | "path" | "price"> & { price?: number; contentType?: string; header?: string | null } = {},
  ): Promise<PaidResult> {
    const price = opts.price ?? priceOf(path);
    const header = opts.header === null ? undefined : (opts.header ?? this.header({ ...opts, sellerId, method, path, price }));
    const res = await app.inject({
      method,
      url: `/s/${sellerId}${path}`,
      headers: {
        ...(header ? { [X402_HEADERS.signature]: header } : {}),
        ...(opts.body !== undefined ? { "content-type": opts.contentType ?? "application/json" } : {}),
      },
      payload: opts.body,
    });
    const payment = decodeX402Header<SettlementResponse>(res.headers[X402_HEADERS.response.toLowerCase()] as string | undefined);
    const required = decodeX402Header<PaymentRequired>(res.headers[X402_HEADERS.required.toLowerCase()] as string | undefined);
    if (payment) {
      const last = this.channel(sellerId);
      this.seqs.set(sellerId, { seq: last.seq + 1, cumulative: last.cumulative + price });
    }
    return { status: res.statusCode, body: res.body, res, required, payment, reason: required?.accepts[0]?.extra.reason };
  }

  /** Forget local channel state (simulates an agent restart) or set it explicitly. */
  setChannel(sellerId: string, seq: number, cumulative: number): void {
    this.seqs.set(sellerId, { seq, cumulative });
  }
}

/** Prices of the acme listing by path. */
export function priceOf(path: string): number {
  if (path.startsWith("/v1/search")) return 5_000;
  if (path.startsWith("/v1/products/")) return 2_000;
  if (path.startsWith("/v1/strict")) return 3_000;
  return 1_000;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
