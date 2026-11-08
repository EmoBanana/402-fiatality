/** What the agent has learned so far, what it paid, and a rule-of-thumb ranking of the candidates. */
import { formatCents, type Micros } from "@p402/shared";
import { bestOffer, type HistoryView, type OfferView, type PriceStatus, type ProductView, type ReviewsView } from "./products";
import type { ToolName } from "./tools";

export interface CallRecord {
  n: number;
  tool: ToolName;
  /** Product id, or the normalized search request. */
  key: string;
  status: "accepted" | "voided" | "unpaid" | "failed";
  costMicros: Micros;
  voidReason: string | null;
  /** One line for the prompt notebook. */
  summary: string;
}

export interface Candidate {
  product: ProductView;
  offer: OfferView;
  /** Position among eligible products in search order (0 = most relevant). */
  rank: number;
  rating: number | null;
  reviewCount: number;
  status: PriceStatus | null;
  meanCents: number | null;
  score: number;
}

/** Ratings are shrunk toward this prior, weighted like this many reviews. */
const PRIOR_RATING = 4.0;
const PRIOR_WEIGHT = 25;

export class ResearchState {
  readonly products = new Map<string, ProductView>();
  /** Product ids in the order searches returned them. */
  readonly ranking: string[] = [];
  readonly detailed = new Set<string>();
  readonly history = new Map<string, HistoryView>();
  readonly reviews = new Map<string, ReviewsView>();
  readonly calls: CallRecord[] = [];
  /** Tools the tab's policy refused (seller_not_allowed, price_above_limit). */
  readonly blocked = new Set<ToolName>();
  spentMicros: Micros = 0;
  private shortlistIds: string[] | null = null;

  get paidCalls(): number {
    return this.calls.filter((c) => c.status === "accepted" || c.status === "voided").length;
  }

  get voidedCalls(): number {
    return this.calls.filter((c) => c.status === "voided").length;
  }

  record(call: Omit<CallRecord, "n">): CallRecord {
    const record = { ...call, n: this.calls.length + 1 };
    this.calls.push(record);
    this.spentMicros += call.costMicros;
    return record;
  }

  addSearchResults(products: ProductView[]): void {
    for (const product of products) {
      this.merge(product);
      if (!this.ranking.includes(product.id)) this.ranking.push(product.id);
    }
  }

  addDetails(requestedId: string, product: ProductView): void {
    this.merge({ ...product, id: requestedId });
    this.detailed.add(requestedId);
    if (!this.ranking.includes(requestedId)) this.ranking.push(requestedId);
  }

  private merge(product: ProductView): void {
    const prev = this.products.get(product.id);
    if (!prev) {
      this.products.set(product.id, product);
      return;
    }
    this.products.set(product.id, {
      ...prev,
      title: product.title || prev.title,
      brand: product.brand ?? prev.brand,
      description: product.description ?? prev.description,
      features: product.features.length > 0 ? product.features : prev.features,
      imageUrl: product.imageUrl ?? prev.imageUrl,
      offers: product.offers.length > 0 ? product.offers : prev.offers,
    });
  }

  attempts(tool: ToolName, key: string): number {
    return this.calls.filter((c) => c.tool === tool && c.key === key).length;
  }

  /** Do we already hold this tool's answer for this key? */
  has(tool: ToolName, key: string): boolean {
    switch (tool) {
      case "details":
        return this.detailed.has(key);
      case "price_history":
        return this.history.has(key);
      case "reviews":
        return this.reviews.has(key);
      case "search":
        return this.calls.some((c) => c.tool === "search" && c.key === key && c.status !== "voided" && c.status !== "failed");
    }
  }

  /** In-stock products within the price limit, in search order. */
  eligible(maxPriceCents: number | null): Array<{ product: ProductView; offer: OfferView }> {
    const out: Array<{ product: ProductView; offer: OfferView }> = [];
    for (const id of this.ranking) {
      const product = this.products.get(id);
      const offer = product ? bestOffer(product) : null;
      if (!product || !offer?.inStock) continue;
      if (maxPriceCents !== null && offer.priceCents > maxPriceCents) continue;
      out.push({ product, offer });
    }
    return out;
  }

  /** The first `n` eligible products, fixed once chosen so the research doesn't chase a moving target. */
  shortlist(maxPriceCents: number | null, n = 3): string[] {
    if (!this.shortlistIds || this.shortlistIds.length === 0) {
      this.shortlistIds = this.eligible(maxPriceCents)
        .slice(0, n)
        .map((e) => e.product.id);
    }
    return this.shortlistIds;
  }

  /** Eligible products (optionally only `ids`), best first. */
  candidates(maxPriceCents: number | null, ids?: string[]): Candidate[] {
    const eligible = this.eligible(maxPriceCents).filter((e) => !ids || ids.includes(e.product.id));
    if (eligible.length === 0) return [];
    const prices = eligible.map((e) => e.offer.priceCents).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)] ?? 1;
    return eligible
      .map((e, rank): Candidate => {
        const reviews = this.reviews.get(e.product.id);
        const history = this.history.get(e.product.id);
        const rating = reviews?.rating ?? null;
        const reviewCount = reviews?.count ?? 0;
        const adjusted =
          rating === null ? PRIOR_RATING - 0.05 : (rating * reviewCount + PRIOR_RATING * PRIOR_WEIGHT) / (reviewCount + PRIOR_WEIGHT);
        const priceTerm = (0.35 * (median - e.offer.priceCents)) / median;
        const timing = history?.status === "low" ? 0.1 : history?.status === "high" ? -0.1 : 0;
        const relevance = 0.2 * (1 - rank / eligible.length);
        return {
          product: e.product,
          offer: e.offer,
          rank,
          rating,
          reviewCount,
          status: history?.status ?? null,
          meanCents: history?.meanCents ?? null,
          score: Math.round((adjusted - PRIOR_RATING + priceTerm + timing + relevance) * 1_000) / 1_000,
        };
      })
      .sort((a, b) => b.score - a.score || a.rank - b.rank);
  }
}

/** "4.5/5 from 954 reviews, price low vs the 30-day mean $356.19" */
export function evidence(c: Pick<Candidate, "rating" | "reviewCount" | "status" | "meanCents">): string {
  const parts: string[] = [];
  parts.push(c.rating === null ? "no rating yet" : `${c.rating.toFixed(1)}/5 from ${c.reviewCount.toLocaleString("en-US")} reviews`);
  if (c.status) parts.push(`price ${c.status}${c.meanCents ? ` vs the 30-day mean ${formatCents(c.meanCents)}` : ""}`);
  return parts.join(", ");
}

export function describeCandidate(c: Candidate): string {
  return `${c.product.title}, ${formatCents(c.offer.priceCents)}${c.offer.domain ? ` at ${c.offer.domain}` : ""} (${evidence(c)})`;
}
