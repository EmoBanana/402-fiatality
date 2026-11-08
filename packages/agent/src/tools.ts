/**
 * The agent's four paid tools, mapped onto catalog endpoints and called through the X402Client.
 * Each call returns what it cost, whether the gateway accepted or voided it, and the parsed data.
 */
import type { CatalogEntryDTO, HttpMethod, Micros } from "@p402/shared";
import { type HistoryView, parseHistory, parseProduct, parseReviews, parseSearch, type ProductView, type ReviewsView } from "./products";
import { matchPath, type X402Client } from "./x402Client";

export type ToolName = "search" | "details" | "price_history" | "reviews";

export interface ToolSpec {
  name: ToolName;
  sellerId: string;
  method: HttpMethod;
  path: string;
  priceMicros: Micros;
  /** One line for the LLM prompt. */
  blurb: string;
}

/** Default wiring to the demo sellers; prices are replaced by the live catalog's. */
export const DEFAULT_TOOLS: readonly ToolSpec[] = [
  { name: "search", sellerId: "channel3", method: "POST", path: "/v1/search", priceMicros: 5_000, blurb: "find products by text; returns ids, titles, prices and stock" },
  { name: "details", sellerId: "channel3", method: "GET", path: "/v1/products/:id", priceMicros: 2_000, blurb: "full description, key features and every merchant offer" },
  { name: "price_history", sellerId: "pricewatch", method: "GET", path: "/v1/history/:productId", priceMicros: 10_000, blurb: "30-day price stats: is today's price low, typical or high?" },
  { name: "reviews", sellerId: "reviews", method: "GET", path: "/v1/reviews/:productId", priceMicros: 3_000, blurb: "rating, review count, pros and cons; flaky, but a failed call is voided and costs nothing" },
];

/**
 * Tools available on this gateway: the catalog decides which exist and what they cost. Without a catalog
 * (unreachable) every default tool is assumed and calls go through 402 quotes.
 */
export function resolveTools(catalog: CatalogEntryDTO[] | null): Map<ToolName, ToolSpec> {
  const tools = new Map<ToolName, ToolSpec>();
  for (const spec of DEFAULT_TOOLS) {
    if (!catalog) {
      tools.set(spec.name, spec);
      continue;
    }
    const sellers = [...catalog].sort((a, b) => Number(b.sellerId === spec.sellerId) - Number(a.sellerId === spec.sellerId));
    for (const entry of sellers) {
      const endpoint = entry.endpoints.find((ep) => ep.method === spec.method && ep.path === spec.path);
      if (endpoint) {
        tools.set(spec.name, { ...spec, sellerId: entry.sellerId, priceMicros: endpoint.priceMicros });
        break;
      }
    }
  }
  return tools;
}

export interface ToolCall<T> {
  tool: ToolName;
  sellerId: string;
  /** "GET /v1/products/esp-1001" */
  endpoint: string;
  /** accepted / voided per PAYMENT-RESPONSE; "unpaid" when the gateway sent none. */
  status: "accepted" | "voided" | "unpaid";
  costMicros: Micros;
  priceMicros: Micros;
  voidReason: string | null;
  httpStatus: number;
  data: T | null;
  /** Why `data` is null. */
  problem: string | null;
  seq: number | null;
  channelCumulativeMicros: Micros | null;
  waitedMs: number;
}

export interface SearchArgs {
  query: string;
  maxPriceCents?: number | null;
  limit?: number;
}

const id = (value: string) => encodeURIComponent(value);

export class ShopTools {
  constructor(
    private readonly client: X402Client,
    readonly specs: Map<ToolName, ToolSpec>,
  ) {}

  has(name: ToolName): boolean {
    return this.specs.has(name);
  }

  spec(name: ToolName): ToolSpec {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Tool ${name} is not available on this gateway`);
    return spec;
  }

  search(args: SearchArgs): Promise<ToolCall<ProductView[]>> {
    const body: Record<string, unknown> = { query: args.query, limit: args.limit ?? 10 };
    if (args.maxPriceCents) body.filters = { price: { max_price: args.maxPriceCents / 100 } };
    return this.call("search", this.spec("search").path, body, parseSearch);
  }

  details(productId: string): Promise<ToolCall<ProductView>> {
    return this.call("details", fill(this.spec("details").path, productId), undefined, parseProduct);
  }

  /** `currentCents` lets pricewatch model products it doesn't track (e.g. real Channel3 ids). */
  priceHistory(productId: string, currentCents?: number | null): Promise<ToolCall<HistoryView>> {
    const query = currentCents ? `?current_price=${(currentCents / 100).toFixed(2)}` : "";
    return this.call("price_history", `${fill(this.spec("price_history").path, productId)}${query}`, undefined, parseHistory);
  }

  reviews(productId: string): Promise<ToolCall<ReviewsView>> {
    return this.call("reviews", fill(this.spec("reviews").path, productId), undefined, parseReviews);
  }

  private async call<T>(name: ToolName, path: string, body: unknown, parse: (json: unknown) => T | null): Promise<ToolCall<T>> {
    const spec = this.spec(name);
    const result = await this.client.fetch(this.client.sellerUrl(spec.sellerId, path), { method: spec.method, body });
    const status = result.payment?.status ?? "unpaid";
    const raw = await result.response.text().catch(() => "");
    let data: T | null = null;
    let problem: string | null = null;
    if (status === "voided") problem = `voided (${result.payment?.reason ?? "void rule"})`;
    else if (!result.response.ok) problem = `HTTP ${result.response.status}`;
    else {
      try {
        data = parse(JSON.parse(raw));
        if (data === null) problem = "unexpected response shape";
      } catch {
        problem = "unreadable JSON";
      }
    }
    return {
      tool: name,
      sellerId: spec.sellerId,
      endpoint: result.endpoint,
      status,
      costMicros: result.costMicros,
      priceMicros: result.priceMicros ?? spec.priceMicros,
      voidReason: status === "voided" ? (result.payment?.reason ?? null) : null,
      httpStatus: result.response.status,
      data,
      problem,
      seq: result.seq,
      channelCumulativeMicros: result.channelCumulativeMicros,
      waitedMs: result.waitedMs,
    };
  }
}

/** "/v1/products/:id" + "esp-1001" -> "/v1/products/esp-1001" (the endpoint's single path parameter). */
function fill(pattern: string, value: string): string {
  const path = pattern.replace(/:[A-Za-z_]\w*/, id(value));
  if (!matchPath(pattern, path)) throw new Error(`Cannot fill ${pattern} with ${value}`);
  return path;
}
