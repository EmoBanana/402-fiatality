/**
 * A tiny stand-in for the 402 Fiatality gateway, close enough to SPEC §5.3 to exercise the agent: /api/config,
 * /api/catalog, /api/tabs/:id, /api/tabs/:id/keys, /api/purchases and the x402 paywall at /s/:sellerId/*
 * (verification order and reason codes, seq/cumulative, quality guard, PAYMENT-RESPONSE). Test code only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_VOID_RULES,
  X402_HEADERS,
  X402_SCHEME,
  X402_VERSION,
  type CatalogEntryDTO,
  type HttpMethod,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequiredReason,
  type PaymentRequirements,
  type PurchaseDTO,
  type PurchaseProposalDTO,
  type ReviewDTO,
  type SellerCreateDTO,
  type SettlementResponse,
  type TabStatus,
  type VoidRules,
} from "@p402/shared";
import { decodeX402Header, encodeX402Header, requestHash, verifyVoucher } from "@p402/shared/node";

export interface FakeEndpoint {
  method: HttpMethod;
  path: string;
  priceMicros: number;
  /** Price shown in /api/catalog when it differs from the enforced one (amount_mismatch tests). */
  listedPriceMicros?: number;
}

export interface UpstreamReply {
  status: number;
  body: string;
  contentType?: string;
}

export type Upstream = (req: { method: string; path: string; body: string; headers: Record<string, string> }) => Promise<UpstreamReply> | UpstreamReply;

export interface FakeSeller {
  id: string;
  endpoints: FakeEndpoint[];
  voidRules?: Partial<VoidRules>;
  upstream: Upstream;
  /** Listed in /api/catalog (default true). */
  listed?: boolean;
}

export interface FakeVoucher {
  id: string;
  sellerId: string;
  seq: number;
  priceMicros: number;
  cumulativeMicros: number;
  reqHash: string;
  path: string;
  agent: string | undefined;
  task: string | undefined;
  status: "accepted" | "voided";
  voidReason: string | null;
}

export interface FakeRequest {
  method: string;
  url: string;
  paid: boolean;
  status: number;
  reason?: PaymentRequiredReason;
  adminHeader: boolean;
}

export interface FakePaywallOptions {
  tabId: string;
  sellers: FakeSeller[];
  enrollToken?: string;
  /** Pause the tab once the same request was accepted this many times (repeat_request alarm). */
  repeatThreshold?: number;
  /** While paused, answer this many paused polls, then freeze the tab (a stand-in AI review). */
  freezeAfterPolls?: number;
  retryAfterSec?: number;
  /** POST /api/purchases answers 400 for data: image URLs (a strict validator). */
  rejectDataImages?: boolean;
  /** Demo clock fast-forward, reported by GET /api/clock. Like the gateway, expiry ignores it. */
  clockOffsetMs?: number;
  /** The gateway machine's wall clock minus ours: voucher expiry is judged against Date.now() + this. */
  wallSkewMs?: number;
}

export class FakePaywall {
  url = "";
  status: TabStatus = "active";
  holdMicros = 50_000_000;
  readonly keys = new Map<string, string>();
  readonly channels = new Map<string, { seq: number; cumulative: number }>();
  readonly vouchers: FakeVoucher[] = [];
  readonly requests: FakeRequest[] = [];
  readonly purchases: PurchaseProposalDTO[] = [];
  readonly reviews: ReviewDTO[] = [];
  /** Called before each paid request is judged (tests flip the tab status here). */
  beforePaywall?: (fake: FakePaywall) => void;
  private pausedPolls = 0;
  private opts: FakePaywallOptions;

  private constructor(
    private readonly server: Server,
    opts: FakePaywallOptions,
  ) {
    this.opts = opts;
  }

  static async start(port: number, opts: FakePaywallOptions): Promise<FakePaywall> {
    let fake: FakePaywall | null = null;
    const server = createServer((req, res) => {
      fake?.handle(req, res).catch((err: unknown) => json(res, 500, { error: "internal", message: String(err) }));
    });
    fake = new FakePaywall(server, opts);
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return fake;
  }

  get tabId(): string {
    return this.opts.tabId;
  }

  /** Start over with new options (same port). */
  reset(opts: FakePaywallOptions): void {
    this.opts = opts;
    this.status = "active";
    this.holdMicros = 50_000_000;
    this.pausedPolls = 0;
    this.beforePaywall = undefined;
    this.keys.clear();
    this.channels.clear();
    this.vouchers.length = 0;
    this.requests.length = 0;
    this.purchases.length = 0;
    this.reviews.length = 0;
  }

  billableMicros(): number {
    return this.vouchers.filter((v) => v.status === "accepted").reduce((s, v) => s + v.priceMicros, 0);
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // ------------------------------------------------------------ routing

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const url = req.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const method = req.method ?? "GET";
    const admin = typeof req.headers["x-p402-admin"] === "string";

    const paywall = /^\/s\/([^/]+)(\/.*)?$/.exec(path);
    if (paywall?.[1]) {
      const sellerId = decodeURIComponent(paywall[1]);
      const rest = url.slice(`/s/${paywall[1]}`.length) || "/";
      return this.paywall(req, res, sellerId, rest, raw, admin);
    }

    const record = (status: number) => this.requests.push({ method, url, paid: false, status, adminHeader: admin });
    if (method === "GET" && path === "/api/config") {
      record(200);
      return json(res, 200, { paypalMode: "mock", currency: "USD", demo: true, publicBaseUrl: this.url, llm: { provider: "mock", model: "gemma4:12b" } });
    }
    if (method === "GET" && path === "/api/clock") {
      record(200);
      const offsetMs = this.opts.clockOffsetMs ?? 0;
      return json(res, 200, { now: Date.now() + (this.opts.wallSkewMs ?? 0) + offsetMs, offsetMs });
    }
    if (method === "GET" && path === "/api/catalog") {
      record(200);
      return json(res, 200, this.catalog());
    }
    const tab = /^\/api\/tabs\/([^/]+)(\/keys)?$/.exec(path);
    if (tab?.[1]) {
      if (decodeURIComponent(tab[1]) !== this.opts.tabId) {
        record(404);
        return json(res, 404, { error: "not_found", message: "Tab not found" });
      }
      if (method === "POST" && tab[2]) {
        const body = JSON.parse(raw) as { agentId: string; publicKey: string; enrollToken: string };
        if (body.enrollToken !== (this.opts.enrollToken ?? "enroll-secret")) {
          record(403);
          return json(res, 403, { error: "forbidden", message: "Bad enroll token" });
        }
        this.keys.set(body.agentId, body.publicKey);
        record(200);
        return json(res, 200, { ok: true });
      }
      if (method === "GET" && !tab[2]) {
        record(200);
        const billable = this.billableMicros();
        return json(res, 200, {
          id: this.opts.tabId,
          status: this.status,
          totals: { billableMicros: billable, remainingMicros: Math.max(0, this.holdMicros - billable) },
          channels: [...this.channels].map(([sellerId, c]) => ({ sellerId, lastSeq: c.seq, lastCumulativeMicros: c.cumulative })),
          alarms: [],
          reviews: this.reviews,
          settlements: [],
        });
      }
    }
    if (method === "POST" && path === "/api/purchases") {
      const body = JSON.parse(raw) as PurchaseProposalDTO;
      if (this.opts.rejectDataImages && body.imageUrl?.startsWith("data:")) {
        record(400);
        return json(res, 400, { error: "invalid_request", message: "imageUrl must be http(s)" });
      }
      this.purchases.push(body);
      record(201);
      const purchase: PurchaseDTO = { id: `pur_${this.purchases.length}`, ...body, status: "proposed", createdAt: Date.now() };
      return json(res, 201, purchase);
    }
    record(404);
    return json(res, 404, { error: "not_found", message: `No route ${method} ${path}` });
  }

  private catalog(): CatalogEntryDTO[] {
    return this.opts.sellers
      .filter((s) => s.listed !== false)
      .map((s) => ({
        sellerId: s.id,
        sellerName: s.id,
        gatewayUrl: `${this.url}/s/${s.id}`,
        voidRules: { ...DEFAULT_VOID_RULES, ...s.voidRules },
        endpoints: s.endpoints.map((ep, i) => ({
          id: `ep_${s.id}_${i}`,
          method: ep.method,
          path: ep.path,
          priceMicros: ep.listedPriceMicros ?? ep.priceMicros,
          description: null,
        })),
      }));
  }

  // ------------------------------------------------------------ paywall

  private async paywall(req: IncomingMessage, res: ServerResponse, sellerId: string, rest: string, raw: string, admin: boolean): Promise<void> {
    const method = req.method ?? "GET";
    const seller = this.opts.sellers.find((s) => s.id === sellerId);
    const index = seller?.endpoints.findIndex((ep) => ep.method === method && matches(ep.path, rest.split("?")[0] ?? "/")) ?? -1;
    const endpoint = seller?.endpoints[index];
    const header = req.headers[X402_HEADERS.signature.toLowerCase()];
    const log = (status: number, reason?: PaymentRequiredReason) =>
      this.requests.push({ method, url: req.url ?? "", paid: typeof header === "string", status, reason, adminHeader: admin });
    if (!seller || !endpoint) {
      log(404);
      return json(res, 404, { error: "not_found", message: "Unknown endpoint" });
    }

    const rules: VoidRules = { ...DEFAULT_VOID_RULES, ...seller.voidRules };
    const requirements: PaymentRequirements = {
      scheme: X402_SCHEME,
      network: "paypal:mock",
      asset: "USD",
      amount: String(endpoint.priceMicros),
      payTo: seller.id,
      maxTimeoutSeconds: 300,
      extra: { decimals: 6, endpointId: `ep_${seller.id}_${index}`, tabEndpoint: `${this.url}/api/tabs`, catalogUrl: `${this.url}/api/catalog`, voidRules: rules },
    };
    const deny = (reason: PaymentRequiredReason, extra: Partial<PaymentRequirements["extra"]> = {}, headers: Record<string, string> = {}) => {
      log(402, reason);
      const required: PaymentRequired = {
        x402Version: X402_VERSION,
        error: reason,
        resource: { url: `${this.url}/s/${seller.id}${rest}` },
        accepts: [{ ...requirements, extra: { ...requirements.extra, reason, ...extra } }],
      };
      res.writeHead(402, { "content-type": "application/json", [X402_HEADERS.required]: encodeX402Header(required), ...headers });
      res.end(JSON.stringify(required));
    };

    if (typeof header !== "string") return deny("payment_required");
    const payload = decodeX402Header<PaymentPayload>(header);
    const signed = payload?.payload;
    if (!signed?.voucher) return deny("invalid_voucher");
    this.beforePaywall?.(this);

    if (this.status === "paused") {
      this.pausedPolls += 1;
      if (this.opts.freezeAfterPolls !== undefined && this.pausedPolls > this.opts.freezeAfterPolls) {
        this.status = "frozen";
        this.reviews.push({
          id: "rev_1",
          tabId: this.opts.tabId,
          status: "done",
          verdict: "freeze",
          fault: "agent",
          confidence: 0.93,
          reason: "The agent repeated one search without using the results.",
          voidedVoucherIds: [],
          transcript: [],
          createdAt: Date.now(),
        });
      } else {
        const after = this.opts.retryAfterSec ?? 1;
        return deny("tab_paused", { retryAfterSec: after, message: "Tab paused: repeat_request alarm, AI review running" }, { "retry-after": String(after) });
      }
    }
    if (this.status === "frozen") return deny("tab_frozen", { message: "Tab frozen by AI review" });
    if (this.status !== "active") return deny("tab_not_active");

    const v = signed.voucher;
    const publicKey = this.keys.get(v.agent ?? "");
    if (!publicKey || v.tab !== this.opts.tabId || !verifyVoucher(signed, publicKey)) return deny("invalid_signature");
    if (v.seller !== seller.id || v.price !== String(endpoint.priceMicros)) return deny("amount_mismatch");
    const nowSec = Math.floor((Date.now() + (this.opts.wallSkewMs ?? 0)) / 1000);
    if (v.iat > nowSec + 30 || v.exp <= nowSec || v.exp - v.iat > 300) return deny("voucher_expired");
    if (v.reqHash !== requestHash(method, rest, raw)) return deny("invalid_voucher");
    const channel = this.channels.get(seller.id) ?? { seq: 0, cumulative: 0 };
    const expectedSeq = channel.seq + 1;
    const expectedCumulative = channel.cumulative + endpoint.priceMicros;
    if (v.seq !== expectedSeq || v.cumulative !== String(expectedCumulative)) {
      return deny("stale_sequence", { expectedSeq, expectedCumulative: String(expectedCumulative) });
    }
    if (this.billableMicros() + endpoint.priceMicros > this.holdMicros) return deny("hold_exhausted");
    this.channels.set(seller.id, { seq: expectedSeq, cumulative: expectedCumulative });

    const reply = await seller.upstream({ method, path: rest, body: raw, headers: lowerHeaders(req) });
    const voidReason = judge(reply, rules);
    const voucher: FakeVoucher = {
      id: `v_${this.vouchers.length + 1}`,
      sellerId: seller.id,
      seq: v.seq,
      priceMicros: endpoint.priceMicros,
      cumulativeMicros: expectedCumulative,
      reqHash: v.reqHash,
      path: rest,
      agent: v.agent,
      task: v.task,
      status: voidReason ? "voided" : "accepted",
      voidReason,
    };
    this.vouchers.push(voucher);
    const repeats = this.vouchers.filter((x) => x.reqHash === voucher.reqHash && x.status === "accepted").length;
    if (this.opts.repeatThreshold && repeats >= this.opts.repeatThreshold) this.status = "paused";

    const settlement: SettlementResponse = {
      success: true,
      scheme: X402_SCHEME,
      network: "paypal:mock",
      transaction: voucher.id,
      status: voucher.status,
      amount: voidReason ? "0" : String(endpoint.priceMicros),
      cumulative: String(expectedCumulative),
      ...(voidReason ? { reason: voidReason } : {}),
    };
    log(reply.status);
    res.writeHead(reply.status, {
      "content-type": reply.contentType ?? "application/json",
      [X402_HEADERS.response]: encodeX402Header(settlement),
      "x-p402-voucher": voucher.id,
    });
    res.end(reply.body);
  }
}

/** Forward to a real seller over HTTP with its key injected (what the gateway does). */
export function httpUpstream(baseUrl: string, authHeader: string, apiKey: string): Upstream {
  return async ({ method, path, body }) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { [authHeader]: apiKey, ...(body ? { "content-type": "application/json" } : {}) },
      body: body || undefined,
    });
    return { status: res.status, body: await res.text(), contentType: res.headers.get("content-type") ?? undefined };
  };
}

/** FakeSellers for the demo sellers' listings (demoSellers(config)). */
export function fakeSellersFrom(listings: SellerCreateDTO[]): FakeSeller[] {
  return listings.map((s) => ({
    id: s.id,
    endpoints: s.endpoints.map((ep) => ({ method: ep.method, path: ep.path, priceMicros: ep.priceMicros })),
    voidRules: s.voidRules,
    upstream: httpUpstream(s.baseUrl, s.authHeader ?? "x-api-key", s.apiKey ?? ""),
  }));
}

export function jsonReply(body: unknown, status = 200): UpstreamReply {
  return { status, body: JSON.stringify(body), contentType: "application/json" };
}

function judge(reply: UpstreamReply, rules: VoidRules): string | null {
  if (reply.status >= 500 && rules.on5xx) return "upstream_5xx";
  if (reply.status >= 400 && reply.status < 500 && reply.status !== 402 && rules.on4xx) return "upstream_4xx";
  if ((reply.contentType ?? "").includes("json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(reply.body);
    } catch {
      return rules.requireJson ? "malformed_json" : null;
    }
    if (!rules.emptyIsBillable) {
      if (parsed === null || (Array.isArray(parsed) && parsed.length === 0) || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) {
        return "empty_result";
      }
      for (const path of rules.emptyResultPaths) {
        const value = path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), parsed);
        if (Array.isArray(value) && value.length === 0) return "empty_result";
      }
    }
  } else if (!rules.emptyIsBillable && reply.body.trim() === "") {
    return "empty_result";
  }
  return null;
}

function matches(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((seg, i) => (seg.startsWith(":") ? got[i] !== "" : seg === got[i]));
}

function lowerHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") out[k.toLowerCase()] = v;
  return out;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
