/**
 * x402 client for the PayPal 402 gateway (SPEC §8.1): the PayPal binding of the `batch-settlement` scheme.
 *
 * Every paid call carries one signed IOU (`PAYMENT-SIGNATURE`) whose `cumulative` is the running total owed to
 * that seller on the tab. Prices come from GET /api/catalog, so a known endpoint is paid on the first request
 * (one round trip); anything else goes through the 402 quote. On 402 the client resyncs (`stale_sequence`),
 * reprices once (`amount_mismatch`), waits (`tab_paused`) or gives up with an X402Error.
 *
 * Channel state (seq, cumulative) lives in a ChannelBook shared by every client in the process, and calls on
 * one (gateway, tab, seller) channel are serialized, so concurrent agents on a tab never race their sequence
 * numbers. Other processes on the same tab are handled by the stale_sequence resync.
 */
import {
  X402_HEADERS,
  X402_SCHEME,
  X402_VERSION,
  type CatalogEntryDTO,
  type ConfigDTO,
  type Micros,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequiredReason,
  type PaymentRequirements,
  type PaypalNetwork,
  type SettlementResponse,
  type Voucher,
} from "@p402/shared";
import { encodeX402Header, decodeX402Header, randomNonce, requestHash, signVoucher } from "@p402/shared/node";
import { GatewayApi } from "./gatewayApi";
import { errorMessage, parseMicros, retryDelayMs, sleep, withTimeout } from "./util";

/** Voucher lifetime: iat + 120 s. */
export const VOUCHER_TTL_SEC = 120;

export type X402ErrorReason = PaymentRequiredReason | "paused_timeout" | "network_error" | "bad_quote" | "not_paywall_url";

const TAB_REASONS: ReadonlySet<X402ErrorReason> = new Set([
  "tab_not_found",
  "tab_not_active",
  "tab_paused",
  "tab_frozen",
  "hold_exhausted",
  "daily_cap_reached",
  "rate_limited",
  "invalid_signature",
  "paused_timeout",
]);
const SELLER_REASONS: ReadonlySet<X402ErrorReason> = new Set(["seller_not_allowed", "price_above_limit"]);

export class X402Error extends Error {
  override name = "X402Error";
  readonly reason: X402ErrorReason;
  readonly status: number | null;
  readonly sellerId: string | null;
  readonly required: PaymentRequired | null;

  constructor(
    reason: X402ErrorReason,
    message: string,
    details: { status?: number; sellerId?: string; required?: PaymentRequired | null } = {},
  ) {
    super(message);
    this.reason = reason;
    this.status = details.status ?? null;
    this.sellerId = details.sellerId ?? null;
    this.required = details.required ?? null;
  }

  /** "tab": stop calling entirely. "seller": stop calling this seller. "call": only this call failed. */
  get scope(): "tab" | "seller" | "call" {
    return TAB_REASONS.has(this.reason) ? "tab" : SELLER_REASONS.has(this.reason) ? "seller" : "call";
  }
}

// ---------------------------------------------------------------- channel book

/** The last voucher the gateway took on a channel (0 / 0 before the first). */
export interface ChannelState {
  seq: number;
  cumulative: Micros;
}

export class ChannelBook {
  private readonly states = new Map<string, ChannelState>();
  private readonly tails = new Map<string, Promise<void>>();

  get(key: string): ChannelState {
    const state = this.states.get(key);
    return state ? { ...state } : { seq: 0, cumulative: 0 };
  }

  set(key: string, state: ChannelState): void {
    this.states.set(key, { ...state });
  }

  /** Run `fn` with this channel to itself. */
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Process-wide channel state, shared by every X402Client unless one is injected. */
export const sharedChannels = new ChannelBook();

// ---------------------------------------------------------------- client

export interface PauseInfo {
  sellerId: string;
  /** "GET /v1/reviews/esp-1001" */
  endpoint: string;
  /** 1 for the first 402 tab_paused of this call. */
  attempt: number;
  waitMs: number;
  /** Already waited on this call before this wait. */
  waitedMs: number;
  message: string;
}

export interface X402ClientOptions {
  /** Gateway origin, e.g. http://localhost:4020. */
  gatewayUrl: string;
  tabId: string;
  agentId: string;
  /** Ed25519 private key, JWK JSON (generateAgentKeyPair). */
  privateKey: string;
  /** Written into every voucher for cost attribution. */
  taskId?: string;
  /** Headers for the gateway's /api routes (catalog, config). Never sent to sellers. */
  apiHeaders?: Record<string, string>;
  signal?: AbortSignal;
  /** Called on every 402 tab_paused, before waiting. */
  onPaused?: (info: PauseInfo) => void;
  /** Longest one call waits for a paused tab, in total (default 120 s). */
  maxPauseWaitMs?: number;
  /** Refuse quotes above this price per call (default $1). */
  maxPriceMicros?: Micros;
  /** Per request; the gateway's own upstream timeout is at most 60 s (default 65 s). */
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Clock for voucher iat/exp (default Date.now). */
  now?: () => number;
  channels?: ChannelBook;
  api?: GatewayApi;
}

export interface X402RequestInit {
  /** GET or POST (default GET). */
  method?: string;
  /** A string is sent as-is; anything else is JSON-encoded. */
  body?: unknown;
  /** Extra headers for the seller. */
  headers?: Record<string, string>;
}

export interface X402Result {
  response: Response;
  /** Decoded PAYMENT-RESPONSE, or null when the call was not paid. */
  payment: SettlementResponse | null;
  /** What this call costs: the price when accepted, 0 when voided or unpaid. */
  costMicros: Micros;
  sellerId: string;
  /** Method and concrete path, e.g. "GET /v1/products/esp-1001". */
  endpoint: string;
  /** Price signed for (null when no voucher was sent). */
  priceMicros: Micros | null;
  seq: number | null;
  /** Channel total for (tab, seller) after this call, voided calls included. */
  channelCumulativeMicros: Micros | null;
  /** Time spent waiting on a paused tab. */
  waitedMs: number;
}

interface Target {
  url: string;
  sellerId: string;
  /** Path after /s/<sellerId>, no query. */
  path: string;
  /** What the voucher's reqHash binds: path + query. */
  pathWithQuery: string;
}

const ERROR_FIELDS = ["reason", "message", "expectedSeq", "expectedCumulative", "retryAfterSec"] as const;

export class X402Client {
  readonly gatewayUrl: string;
  readonly api: GatewayApi;
  private readonly channels: ChannelBook;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private catalogPromise: Promise<CatalogEntryDTO[] | null> | null = null;
  private configPromise: Promise<ConfigDTO | null> | null = null;
  /** `extra` from the latest 402 per "<seller> <endpointId>", reused in later vouchers. */
  private readonly quotedExtra = new Map<string, PaymentRequirements["extra"]>();
  /** Prices learned from amount_mismatch, per "<seller> <endpointId>". */
  private readonly repriced = new Map<string, Micros>();
  /** Gateway clock minus ours, learned after a voucher_expired (demo clock fast-forwarded). */
  private clockSkewMs = 0;

  constructor(private readonly opts: X402ClientOptions) {
    this.gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.channels = opts.channels ?? sharedChannels;
    this.fetchImpl = opts.fetch ?? fetch;
    this.sleepImpl = opts.sleep ?? sleep;
    this.now = opts.now ?? Date.now;
    this.api =
      opts.api ?? new GatewayApi({ gatewayUrl: this.gatewayUrl, headers: opts.apiHeaders, fetch: this.fetchImpl, signal: opts.signal });
  }

  /** The paywall URL for a seller path: `${gateway}/s/<sellerId><path>`. */
  sellerUrl(sellerId: string, path: string): string {
    return `${this.gatewayUrl}/s/${encodeURIComponent(sellerId)}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /** Cached GET /api/catalog; null when the gateway can't serve it (calls then go through 402 quotes). */
  catalog(): Promise<CatalogEntryDTO[] | null> {
    this.catalogPromise ??= this.api.catalog().catch((err) => {
      if (this.opts.signal?.aborted) throw err;
      return null;
    });
    return this.catalogPromise;
  }

  refreshCatalog(): Promise<CatalogEntryDTO[] | null> {
    this.catalogPromise = null;
    return this.catalog();
  }

  /** Channel state as this process knows it. */
  channel(sellerId: string): ChannelState {
    return this.channels.get(this.channelKey(sellerId));
  }

  async fetch(url: string, init: X402RequestInit = {}): Promise<X402Result> {
    const target = this.parseTarget(url);
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body === undefined || init.body === null ? "" : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
    if (body && (method === "GET" || method === "HEAD")) throw new TypeError(`${method} requests cannot have a body`);
    return this.channels.exclusive(this.channelKey(target.sellerId), () => this.send(target, method, body, init.headers ?? {}));
  }

  // ------------------------------------------------------------ internals

  private async send(target: Target, method: string, body: string, extraHeaders: Record<string, string>): Promise<X402Result> {
    const key = this.channelKey(target.sellerId);
    const endpoint = `${method} ${target.path}`;
    let requirements = await this.knownRequirements(target, method);
    let quoted = false;
    let resynced = false;
    let repriced = false;
    let reclocked = false;
    let pauses = 0;
    let waitedMs = 0;

    for (;;) {
      this.opts.signal?.throwIfAborted();
      const headers: Record<string, string> = { accept: "application/json", ...extraHeaders };
      if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) headers["content-type"] = "application/json";

      let voucher: Voucher | null = null;
      if (requirements) {
        const price = this.priceOf(requirements, target);
        const last = this.channels.get(key);
        voucher = this.voucher(target, method, body, last.seq + 1, price, last.cumulative + price);
        const payload: PaymentPayload = {
          x402Version: X402_VERSION,
          resource: { url: target.url },
          accepted: requirements,
          payload: signVoucher(voucher, this.opts.privateKey),
        };
        headers[X402_HEADERS.signature] = encodeX402Header(payload);
      }

      const res = await this.request(target, method, headers, body);
      const required = res.status === 402 ? decodeX402Header<PaymentRequired>(res.headers.get(X402_HEADERS.required)) : null;

      if (required) {
        await res.body?.cancel().catch(() => {});
        const accept = required.accepts?.[0];
        const extra = accept?.extra;
        const reason: PaymentRequiredReason = extra?.reason ?? "payment_required";
        const message = extra?.message ?? required.error ?? `The gateway refused the call (${reason})`;
        const fail = (why: X402ErrorReason = reason, text = message) =>
          new X402Error(why, text, { status: 402, sellerId: target.sellerId, required });
        const learned = this.learnChannel(key, accept);

        if (reason === "payment_required" && !voucher && !quoted) {
          if (!accept) throw fail("bad_quote", "402 without payment requirements");
          requirements = this.fromQuote(target, accept);
          quoted = true;
          continue;
        }
        if (reason === "stale_sequence" && voucher && !resynced) {
          if (!learned) throw fail("stale_sequence", "stale_sequence without a usable expectedSeq/expectedCumulative");
          resynced = true;
          continue;
        }
        if (reason === "amount_mismatch" && voucher && requirements && !repriced && accept) {
          const price = parseMicros(accept.amount);
          if (price !== null && price !== this.priceOf(requirements, target) && price <= this.maxPrice) {
            requirements = { ...requirements, amount: String(price) };
            const id = requirements.extra.endpointId;
            if (id) this.repriced.set(`${target.sellerId} ${id}`, price);
            repriced = true;
            continue;
          }
        }
        if (reason === "voucher_expired" && voucher && !reclocked) {
          reclocked = true;
          if (await this.syncClock()) continue;
        }
        if (reason === "tab_paused") {
          const waitMs = retryDelayMs(res.headers.get("retry-after"), extra?.retryAfterSec);
          if (waitedMs + waitMs > this.maxPauseWait) {
            throw fail("paused_timeout", `The tab stayed paused for ${Math.round(waitedMs / 1000)} s (${message})`);
          }
          pauses += 1;
          this.opts.onPaused?.({ sellerId: target.sellerId, endpoint, attempt: pauses, waitMs, waitedMs, message });
          await this.sleepImpl(waitMs, this.opts.signal);
          waitedMs += waitMs;
          continue;
        }
        throw fail();
      }

      const payment = decodeX402Header<SettlementResponse>(res.headers.get(X402_HEADERS.response));
      let channelCumulative: Micros | null = null;
      if (payment && voucher) {
        channelCumulative = parseMicros(payment.cumulative) ?? Number(voucher.cumulative);
        this.channels.set(key, { seq: voucher.seq, cumulative: channelCumulative });
      }
      const costMicros = payment && payment.status !== "voided" ? (parseMicros(payment.amount) ?? 0) : 0;
      return {
        response: res,
        payment,
        costMicros,
        sellerId: target.sellerId,
        endpoint,
        priceMicros: voucher ? Number(voucher.price) : null,
        seq: voucher?.seq ?? null,
        channelCumulativeMicros: channelCumulative,
        waitedMs,
      };
    }
  }

  /**
   * A 402 that says what the next voucher must carry tells us the channel's real state. Exact, because the
   * gateway checks the price before the sequence, so `accept.amount` is the price it used.
   */
  private learnChannel(key: string, accept: PaymentRequirements | undefined): boolean {
    const seq = accept?.extra?.expectedSeq;
    const cumulative = parseMicros(accept?.extra?.expectedCumulative);
    const price = parseMicros(accept?.amount);
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || cumulative === null || price === null || cumulative < price) return false;
    this.channels.set(key, { seq: seq - 1, cumulative: cumulative - price });
    return true;
  }

  /**
   * Vouchers carry unix seconds from Date.now(). If the gateway judges expiry by its demo clock after a
   * fast-forward, adopt that clock (GET /api/clock) so the retry is valid. True when the skew changed.
   */
  private async syncClock(): Promise<boolean> {
    const clock = await this.api.clock().catch(() => null);
    if (!clock) return false;
    const skew = clock.now - Date.now();
    if (Math.abs(skew - this.clockSkewMs) < 30_000) return false;
    this.clockSkewMs = skew;
    return true;
  }

  private get maxPauseWait(): number {
    return this.opts.maxPauseWaitMs ?? 120_000;
  }

  private get maxPrice(): Micros {
    return this.opts.maxPriceMicros ?? 1_000_000;
  }

  private async request(target: Target, method: string, headers: Record<string, string>, body: string): Promise<Response> {
    try {
      return await this.fetchImpl(target.url, {
        method,
        headers,
        body: body || undefined,
        signal: withTimeout(this.opts.signal, this.opts.requestTimeoutMs ?? 65_000),
      });
    } catch (err) {
      if (this.opts.signal?.aborted) throw err;
      throw new X402Error("network_error", `Gateway request failed: ${errorMessage(err)}`, { sellerId: target.sellerId });
    }
  }

  private voucher(target: Target, method: string, body: string, seq: number, price: Micros, cumulative: Micros): Voucher {
    const iat = Math.floor((this.now() + this.clockSkewMs) / 1000);
    return {
      v: 1,
      tab: this.opts.tabId,
      seller: target.sellerId,
      seq,
      price: String(price),
      cumulative: String(cumulative),
      reqHash: requestHash(method, target.pathWithQuery, body),
      agent: this.opts.agentId,
      task: this.opts.taskId,
      iat,
      exp: iat + VOUCHER_TTL_SEC,
      nonce: randomNonce(),
    };
  }

  private priceOf(requirements: PaymentRequirements, target: Target): Micros {
    const price = parseMicros(requirements.amount);
    if (price === null || price <= 0) throw new X402Error("bad_quote", `Unusable price "${requirements.amount}"`, { sellerId: target.sellerId });
    return price;
  }

  /** Requirements for a catalog endpoint, so the first request can already pay. */
  private async knownRequirements(target: Target, method: string): Promise<PaymentRequirements | null> {
    const [catalog, config] = await Promise.all([this.catalog(), this.config()]);
    const entry = catalog?.find((e) => e.sellerId === target.sellerId);
    const endpoint = entry?.endpoints.find((ep) => ep.method === method && matchPath(ep.path, target.path));
    if (!entry || !endpoint || !config) return null;
    const key = `${target.sellerId} ${endpoint.id}`;
    const base = config.publicBaseUrl.replace(/\/+$/, "") || this.gatewayUrl;
    return {
      scheme: X402_SCHEME,
      network: `paypal:${config.paypalMode}` as PaypalNetwork,
      asset: "USD",
      amount: String(this.repriced.get(key) ?? endpoint.priceMicros),
      payTo: target.sellerId,
      maxTimeoutSeconds: 300,
      extra: this.quotedExtra.get(key) ?? {
        decimals: 6,
        endpointId: endpoint.id,
        tabEndpoint: `${base}/api/tabs`,
        catalogUrl: `${base}/api/catalog`,
        voidRules: entry.voidRules,
      },
    };
  }

  /** Requirements from a 402 quote, checked before we sign anything against them. */
  private fromQuote(target: Target, accept: PaymentRequirements): PaymentRequirements {
    const price = parseMicros(accept.amount);
    const bad = (why: string) => new X402Error("bad_quote", `Refusing the 402 quote: ${why}`, { status: 402, sellerId: target.sellerId });
    if (accept.scheme !== X402_SCHEME) throw bad(`scheme ${String(accept.scheme)}`);
    if (accept.payTo !== target.sellerId) throw bad(`it pays ${String(accept.payTo)}, not ${target.sellerId}`);
    if (price === null || price <= 0) throw bad(`amount ${String(accept.amount)}`);
    if (price > this.maxPrice) throw bad(`amount ${price} µUSD is above the ${this.maxPrice} µUSD per-call ceiling`);
    const extra = { ...(accept.extra ?? {}) } as PaymentRequirements["extra"];
    for (const field of ERROR_FIELDS) delete extra[field];
    if (extra.endpointId) this.quotedExtra.set(`${target.sellerId} ${extra.endpointId}`, extra);
    return {
      scheme: X402_SCHEME,
      network: accept.network,
      asset: "USD",
      amount: String(price),
      payTo: target.sellerId,
      maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 300,
      extra,
    };
  }

  private config(): Promise<ConfigDTO | null> {
    this.configPromise ??= this.api.config().catch((err) => {
      if (this.opts.signal?.aborted) throw err;
      return null;
    });
    return this.configPromise;
  }

  private parseTarget(url: string): Target {
    const parsed = new URL(url, `${this.gatewayUrl}/`);
    const match = /^\/s\/([^/]+)(\/.*)?$/.exec(parsed.pathname);
    if (!match?.[1]) throw new X402Error("not_paywall_url", `Not a paywall URL (expected /s/<sellerId>/...): ${parsed.pathname}`);
    const path = match[2] ?? "/";
    return { url: parsed.toString(), sellerId: decodeURIComponent(match[1]), path, pathWithQuery: `${path}${parsed.search}` };
  }

  private channelKey(sellerId: string): string {
    return `${this.gatewayUrl}|${this.opts.tabId}|${sellerId}`;
  }
}

/** Does a concrete path match an endpoint pattern with `:params`? */
export function matchPath(pattern: string, path: string): boolean {
  const want = pattern.split("/");
  const got = path.split("/");
  return want.length === got.length && want.every((segment, i) => (segment.startsWith(":") ? got[i] !== "" : segment === got[i]));
}
