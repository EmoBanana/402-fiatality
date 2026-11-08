/**
 * Demo `channel3` seller: a Channel3-shaped product search over the fictional catalog.
 *   POST /v1/search        { query, limit <= 30, filters?: { price: { min, max } | { min_price, max_price } } }
 *                          -> { products, next_page_token }
 *   GET  /v1/products/:id  -> product, or 404 { detail: "Product not found" } like the real API
 * Products are a superset of the real Channel3 model (brands[], image objects, offers[].price.price) and the
 * SPEC §8.3 shape (brand, offers[].price.amount), so agents written against either one work.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bestOffer, CATEGORIES, type CatalogProduct, findProduct, MERCHANT_COMMISSION, PRODUCTS } from "./catalog";
import { productImageUrl } from "./images";

export interface Channel3Offer {
  url: string;
  domain: string;
  price: { amount: number; price: number; compare_at_price: number | null; currency: "USD" };
  availability: "InStock" | "OutOfStock";
  condition: "new";
  max_commission_rate: number;
}

export interface Channel3Product {
  id: string;
  title: string;
  description: string;
  brand: string;
  brands: Array<{ id: string; name: string }>;
  category: { slug: string; title: string; path: string[]; has_children: false };
  images: Array<{ url: string; alt_text: string; is_main_image: boolean }>;
  key_features: string[];
  offers: Channel3Offer[];
}

export interface SearchResponse {
  products: Channel3Product[];
  next_page_token: string | null;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export function toChannel3Product(p: CatalogProduct): Channel3Product {
  const category = CATEGORIES[p.category];
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    brand: p.brand,
    brands: [{ id: `brand_${slug(p.brand)}`, name: p.brand }],
    category: { slug: category.slug, title: category.title, path: category.path, has_children: false },
    images: [{ url: productImageUrl(p), alt_text: p.title, is_main_image: true }],
    key_features: p.features,
    offers: p.offers.map((o) => {
      const dollars = o.priceCents / 100;
      return {
        url: `https://${o.domain}/products/${slug(p.title)}`,
        domain: o.domain,
        price: {
          amount: dollars,
          price: dollars,
          compare_at_price: o.compareAtCents ? o.compareAtCents / 100 : null,
          currency: "USD",
        },
        availability: o.inStock ? "InStock" : "OutOfStock",
        condition: "new",
        max_commission_rate: MERCHANT_COMMISSION[o.domain] ?? 0.05,
      };
    }),
  };
}

// ---------------------------------------------------------------- search

const STOPWORDS = new Set(
  (
    "a an the for with and or of to in on at by from my me i we our you your find buy get need want looking look " +
    "best good great cheap cheapest affordable nice top new please some something that which who is are be " +
    "under below over less than around about up most budget price priced dollar usd max maximum min minimum " +
    "one recommend recommendation help"
  ).split(" "),
);

function stem(word: string): string {
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Lowercase word stems without stopwords or bare numbers. */
export function searchTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(stem)
    .filter((w) => !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

interface IndexedProduct {
  product: CatalogProduct;
  fields: Array<{ terms: Set<string>; weight: number }>;
}

const INDEX: IndexedProduct[] = PRODUCTS.map((product) => ({
  product,
  fields: [
    { terms: new Set(searchTerms(product.title)), weight: 3 },
    { terms: new Set(searchTerms(CATEGORIES[product.category].terms.join(" "))), weight: 3 },
    { terms: new Set(searchTerms(product.brand)), weight: 2 },
    { terms: new Set(searchTerms(`${product.description} ${product.features.join(" ")}`)), weight: 1 },
  ],
}));

function score(entry: IndexedProduct, terms: string[]): number {
  let total = 0;
  let matched = 0;
  for (const term of terms) {
    let best = 0;
    for (const field of entry.fields) if (field.weight > best && field.terms.has(term)) best = field.weight;
    if (best > 0) matched++;
    total += best;
  }
  return matched === terms.length && total > 0 ? total + 1 : total;
}

const priceFilterSchema = z.object({
  min: z.number().min(0).optional(),
  max: z.number().min(0).optional(),
  min_price: z.number().min(0).optional(),
  max_price: z.number().min(0).optional(),
});

export const searchBodySchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(30).default(10),
  filters: z
    .object({
      price: priceFilterSchema.optional(),
      availability: z.array(z.enum(["InStock", "OutOfStock"])).optional(),
      category: z.string().optional(),
    })
    .optional(),
  page_token: z.string().regex(/^\d{1,4}$/).optional(),
});

export type SearchBody = z.infer<typeof searchBodySchema>;

export function searchCatalog(body: SearchBody): SearchResponse {
  const terms = searchTerms(body.query);
  const price = body.filters?.price;
  const minCents = toCents(price?.min_price ?? price?.min);
  const maxCents = toCents(price?.max_price ?? price?.max);
  const inStockOnly = body.filters?.availability?.length === 1 && body.filters.availability[0] === "InStock";
  const category = body.filters?.category?.toLowerCase();

  const scored = INDEX.map((entry) => ({ entry, score: terms.length ? score(entry, terms) : 0 }))
    .filter(({ entry, score }) => {
      if (score <= 0) return false;
      const p = entry.product;
      const offer = bestOffer(p);
      if (minCents !== null && offer.priceCents < minCents) return false;
      if (maxCents !== null && offer.priceCents > maxCents) return false;
      if (inStockOnly && !offer.inStock) return false;
      if (category && ![p.category, CATEGORIES[p.category].slug, CATEGORIES[p.category].title.toLowerCase()].includes(category)) return false;
      return true;
    })
    .sort((a, b) => b.score - a.score || b.entry.product.reviewCount - a.entry.product.reviewCount);

  const top = scored[0]?.score ?? 0;
  const relevant = scored.filter((s) => s.score >= Math.max(2, top * 0.4));
  const offset = body.page_token ? Number(body.page_token) : 0;
  const page = relevant.slice(offset, offset + body.limit);
  const next = offset + body.limit < relevant.length ? String(offset + body.limit) : null;
  return { products: page.map((s) => toChannel3Product(s.entry.product)), next_page_token: next };
}

function toCents(dollars: number | undefined): number | null {
  return dollars === undefined ? null : Math.round(dollars * 100);
}

// ---------------------------------------------------------------- routes

export function channel3Routes(app: FastifyInstance): void {
  app.post("/v1/search", async (request, reply) => {
    const parsed = searchBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ detail: "Invalid search request", errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
    }
    return searchCatalog(parsed.data);
  });

  app.get<{ Params: { id: string } }>("/v1/products/:id", async (request, reply) => {
    const product = findProduct(request.params.id);
    if (!product) return reply.code(404).send({ detail: "Product not found" });
    return toChannel3Product(product);
  });
}
