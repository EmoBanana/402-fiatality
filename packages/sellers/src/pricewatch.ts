/**
 * Demo `pricewatch` seller: GET /v1/history/:productId -> 30-day price stats, deterministic per product.
 * Catalog products follow their hidden trend. Other ids (e.g. real Channel3 products) get a modeled history
 * around `?current_price=<dollars>`; without it they are 404 (not tracked).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bestOffer, findProduct, type PriceTrend } from "./catalog";
import { gaussian, pick, rngFor } from "./rng";

export const HISTORY_DAYS = 30;
/** How many standard deviations from the mean make today's price "low" or "high". */
export const STATUS_Z = 0.75;

export interface PricePoint {
  date: string;
  price: number;
}

export interface PriceHistory {
  product_id: string;
  currency: "USD";
  window_days: number;
  current: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  current_status: PriceTrend;
  points: PricePoint[];
}

const DAY_MS = 86_400_000;
const dollars = (cents: number) => Math.round(cents) / 100;

export function priceHistory(productId: string, opts: { currentCents?: number | null; today?: Date } = {}): PriceHistory | null {
  const product = findProduct(productId);
  const currentCents = product ? bestOffer(product).priceCents : (opts.currentCents ?? null);
  if (!currentCents || currentCents <= 0) return null;

  const rng = rngFor("pricewatch", productId);
  const trend: PriceTrend = product?.trend ?? pick(rng, ["low", "typical", "typical", "high"] as const);
  const factor = trend === "low" ? 1.07 + rng() * 0.06 : trend === "high" ? 0.87 + rng() * 0.05 : 0.995 + rng() * 0.01;
  const base = currentCents * factor;
  const sigma = base * 0.025;

  // AR(1) day-to-day noise, centered so the earlier days average exactly `base` and the trend holds.
  const noise: number[] = [];
  let last = 0;
  for (let i = 0; i < HISTORY_DAYS - 1; i++) {
    last = 0.6 * last + gaussian(rng) * sigma;
    noise.push(last);
  }
  const drift = noise.reduce((s, n) => s + n, 0) / noise.length;
  const cents = noise.map((n) => Math.max(1, Math.round(base + n - drift)));
  cents.push(currentCents);

  const mean = cents.reduce((s, c) => s + c, 0) / cents.length;
  const std = Math.sqrt(cents.reduce((s, c) => s + (c - mean) ** 2, 0) / cents.length);
  const z = std > 0 ? (currentCents - mean) / std : 0;
  const today = Date.UTC(...utcYmd(opts.today ?? new Date()));

  return {
    product_id: productId,
    currency: "USD",
    window_days: HISTORY_DAYS,
    current: dollars(currentCents),
    min: dollars(Math.min(...cents)),
    max: dollars(Math.max(...cents)),
    mean: dollars(mean),
    std: dollars(std),
    current_status: z <= -STATUS_Z ? "low" : z >= STATUS_Z ? "high" : "typical",
    points: cents.map((c, i) => ({
      date: new Date(today - (HISTORY_DAYS - 1 - i) * DAY_MS).toISOString().slice(0, 10),
      price: dollars(c),
    })),
  };
}

function utcYmd(d: Date): [number, number, number] {
  return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()];
}

const historyQuerySchema = z.object({ current_price: z.coerce.number().positive().max(1_000_000).optional().catch(undefined) });

export function pricewatchRoutes(app: FastifyInstance): void {
  app.get<{ Params: { productId: string } }>("/v1/history/:productId", async (request, reply) => {
    const { current_price } = historyQuerySchema.parse(request.query ?? {});
    const history = priceHistory(request.params.productId, {
      currentCents: current_price === undefined ? null : Math.round(current_price * 100),
    });
    if (!history) {
      return reply
        .code(404)
        .send({ error: "not_found", message: "This product is not tracked. Pass ?current_price=<dollars> to model its history." });
    }
    return history;
  });
}
