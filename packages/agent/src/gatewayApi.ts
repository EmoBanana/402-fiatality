/**
 * Typed calls to the gateway's own REST API (never the paywall). Every request carries `headers`
 * (x-p402-admin when DEMO_MODE=0); those headers never reach sellers.
 */
import {
  DEFAULT_VOID_RULES,
  voidRulesSchema,
  type AgentKeyRegisterDTO,
  type ApiErrorDTO,
  type CatalogEntryDTO,
  type ClockDTO,
  type ConfigDTO,
  type OkDTO,
  type PurchaseDTO,
  type PurchaseProposalDTO,
  type TabDetailDTO,
} from "@p402/shared";
import { z } from "zod";
import { errorMessage, withTimeout } from "./util";

export class GatewayApiError extends Error {
  override name = "GatewayApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface GatewayApiOptions {
  /** Gateway origin, e.g. http://localhost:4020. */
  gatewayUrl: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const catalogSchema = z.array(
  z.object({
    sellerId: z.string().min(1),
    sellerName: z.string().catch(""),
    gatewayUrl: z.string().catch(""),
    voidRules: voidRulesSchema.catch(DEFAULT_VOID_RULES),
    endpoints: z.array(
      z.object({
        id: z.string().min(1),
        method: z.enum(["GET", "POST"]),
        path: z.string().startsWith("/"),
        priceMicros: z.number().int().positive(),
        description: z.string().nullish(),
      }),
    ),
  }),
);

const configSchema = z.looseObject({
  paypalMode: z.enum(["mock", "sandbox"]),
  publicBaseUrl: z.string().catch(""),
});

const tabSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  totals: z.looseObject({ remainingMicros: z.number(), billableMicros: z.number() }),
});

const purchaseSchema = z.looseObject({ id: z.string().min(1), status: z.string() });

const clockSchema = z.object({ now: z.number(), offsetMs: z.number() });

export class GatewayApi {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GatewayApiOptions) {
    this.baseUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async config(): Promise<ConfigDTO> {
    return configSchema.parse(await this.request("GET", "/api/config")) as unknown as ConfigDTO;
  }

  async catalog(): Promise<CatalogEntryDTO[]> {
    return catalogSchema.parse(await this.request("GET", "/api/catalog")) as CatalogEntryDTO[];
  }

  async tab(tabId: string): Promise<TabDetailDTO> {
    return tabSchema.parse(await this.request("GET", `/api/tabs/${encodeURIComponent(tabId)}`)) as unknown as TabDetailDTO;
  }

  /** The gateway's (demo) clock: GET /api/clock. */
  async clock(): Promise<ClockDTO> {
    return clockSchema.parse(await this.request("GET", "/api/clock"));
  }

  async registerAgentKey(tabId: string, body: AgentKeyRegisterDTO): Promise<OkDTO> {
    return (await this.request("POST", `/api/tabs/${encodeURIComponent(tabId)}/keys`, body)) as OkDTO;
  }

  async proposePurchase(body: PurchaseProposalDTO): Promise<PurchaseDTO> {
    return purchaseSchema.parse(await this.request("POST", "/api/purchases", body)) as unknown as PurchaseDTO;
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json", ...this.opts.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: withTimeout(this.opts.signal, this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      if (this.opts.signal?.aborted) throw err;
      throw new GatewayApiError(0, "unreachable", `Gateway unreachable at ${this.baseUrl}: ${errorMessage(err)}`);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json ?? {}) as Partial<ApiErrorDTO>;
      throw new GatewayApiError(
        res.status,
        typeof err.error === "string" ? err.error : `http_${res.status}`,
        typeof err.message === "string" ? err.message : `${method} ${path} failed with HTTP ${res.status}`,
      );
    }
    return json;
  }
}
