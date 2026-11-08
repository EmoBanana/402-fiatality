/**
 * Lenient parsers for seller responses (untrusted input). They accept both the real Channel3 product model
 * (brands[], image objects, offers[].price.price) and the demo shape (brand, offers[].price.amount), and
 * reduce everything to the few fields the agent reasons about.
 */
import { z } from "zod";

export type PriceStatus = "low" | "typical" | "high";

export interface OfferView {
  url: string | null;
  domain: string | null;
  priceCents: number;
  currency: string;
  inStock: boolean;
}

export interface ProductView {
  id: string;
  title: string;
  brand: string | null;
  description: string | null;
  features: string[];
  imageUrl: string | null;
  offers: OfferView[];
}

export interface HistoryView {
  currentCents: number;
  minCents: number;
  maxCents: number;
  meanCents: number;
  status: PriceStatus;
}

export interface ReviewsView {
  rating: number | null;
  count: number;
  pros: string[];
  cons: string[];
  quotes: string[];
}

const text = z.string().max(5_000);

const offerSchema = z.object({
  url: text.nullish().catch(null),
  domain: text.nullish().catch(null),
  price: z
    .object({
      amount: z.number().nullish().catch(null),
      price: z.number().nullish().catch(null),
      currency: z.string().nullish().catch(null),
    })
    .nullish()
    .catch(null),
  availability: z.string().nullish().catch(null),
});

const productSchema = z.object({
  id: z.union([z.string().min(1).max(200), z.number()]).transform(String),
  title: z
    .string()
    .min(1)
    .transform((t) => (t.length > 300 ? `${t.slice(0, 299)}…` : t)),
  description: text.nullish().catch(null),
  brand: z.string().nullish().catch(null),
  brands: z.array(z.object({ name: z.string() })).nullish().catch(null),
  images: z
    .array(z.union([z.string(), z.object({ url: z.string() })]))
    .nullish()
    .catch(null),
  key_features: z.array(z.string()).nullish().catch(null),
  offers: z.array(offerSchema).nullish().catch(null),
});

export function parseProduct(raw: unknown): ProductView | null {
  const parsed = productSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const image = p.images?.[0];
  const offers: OfferView[] = [];
  for (const o of p.offers ?? []) {
    const dollars = o.price?.amount ?? o.price?.price;
    if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars <= 0) continue;
    offers.push({
      url: o.url ?? null,
      domain: o.domain ?? hostOf(o.url),
      priceCents: Math.round(dollars * 100),
      currency: (o.price?.currency ?? "USD").toUpperCase(),
      inStock: (o.availability ?? "InStock").toLowerCase().replace(/[^a-z]/g, "") === "instock",
    });
  }
  return {
    id: p.id,
    title: p.title,
    brand: p.brand ?? p.brands?.[0]?.name ?? null,
    description: p.description ?? null,
    features: (p.key_features ?? []).slice(0, 8),
    imageUrl: typeof image === "string" ? image : (image?.url ?? null),
    offers,
  };
}

/** Search results: `{ products: [...] }` (Channel3) or a bare array. Unreadable items are skipped. */
export function parseSearch(raw: unknown): ProductView[] | null {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.products) ? raw.products : null;
  if (!list) return null;
  return list.map(parseProduct).filter((p): p is ProductView => p !== null);
}

/** Cheapest in-stock USD offer, else the cheapest USD offer. */
export function bestOffer(product: ProductView): OfferView | null {
  const usd = product.offers.filter((o) => o.currency === "USD");
  const pool = usd.some((o) => o.inStock) ? usd.filter((o) => o.inStock) : usd;
  return pool.reduce<OfferView | null>((best, o) => (best === null || o.priceCents < best.priceCents ? o : best), null);
}

const historySchema = z.object({
  current: z.number().positive(),
  min: z.number().positive(),
  max: z.number().positive(),
  mean: z.number().positive(),
  std: z.number().nonnegative().optional().catch(undefined),
  current_status: z.enum(["low", "typical", "high"]).optional().catch(undefined),
});

export function parseHistory(raw: unknown): HistoryView | null {
  const parsed = historySchema.safeParse(raw);
  if (!parsed.success) return null;
  const h = parsed.data;
  const status: PriceStatus =
    h.current_status ?? (h.current < h.mean * 0.97 ? "low" : h.current > h.mean * 1.03 ? "high" : "typical");
  return {
    currentCents: Math.round(h.current * 100),
    minCents: Math.round(h.min * 100),
    maxCents: Math.round(h.max * 100),
    meanCents: Math.round(h.mean * 100),
    status,
  };
}

const reviewsSchema = z.object({
  rating: z.number().min(0).max(5).nullable(),
  count: z.number().int().nonnegative(),
  highlights: z
    .object({ pros: z.array(z.string()).catch([]), cons: z.array(z.string()).catch([]) })
    .partial()
    .optional()
    .catch(undefined),
  reviews: z
    .array(z.object({ title: z.string().optional().catch(undefined), body: z.string().optional().catch(undefined) }))
    .optional()
    .catch(undefined),
});

export function parseReviews(raw: unknown): ReviewsView | null {
  const parsed = reviewsSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    rating: r.rating,
    count: r.count,
    pros: (r.highlights?.pros ?? []).slice(0, 4),
    cons: (r.highlights?.cons ?? []).slice(0, 4),
    quotes: (r.reviews ?? [])
      .map((x) => x.title ?? x.body ?? "")
      .filter(Boolean)
      .slice(0, 3),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
