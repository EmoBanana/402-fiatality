import type { RunningSellers } from "@p402/gateway/context";
import { SELLER_ID_PATTERN, voidRulesSchema } from "@p402/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRODUCTS } from "../src/catalog";
import { searchCatalog } from "../src/channel3";
import { CHANNEL3_API_URL, DEMO_PRICES, demoSellers, startSellers } from "../src/index";
import { priceHistory } from "../src/pricewatch";
import { createFlaky, reviewsFor } from "../src/reviews";

let sellers: RunningSellers;
const key = (id: string) => ({ "x-api-key": `demo-${id}-key` });

async function search(body: unknown) {
  const res = await fetch(`${sellers.url}/channel3/v1/search`, {
    method: "POST",
    headers: { ...key("channel3"), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> & { products: Array<Record<string, any>> } };
}

beforeAll(async () => {
  sellers = await startSellers({ port: 4410, host: "127.0.0.1", flakyRate: 0 });
});

afterAll(async () => {
  await sellers.close();
});

describe("demo sellers: auth", () => {
  it("requires each seller's own x-api-key", async () => {
    const product = `${sellers.url}/channel3/v1/products/esp-1001`;
    expect((await fetch(product)).status).toBe(401);
    expect((await fetch(product, { headers: { "x-api-key": "wrong" } })).status).toBe(401);
    expect((await fetch(product, { headers: key("reviews") })).status).toBe(401);
    expect((await fetch(product, { headers: key("channel3") })).status).toBe(200);
    expect((await fetch(`${sellers.url}/pricewatch/v1/history/esp-1001`, { headers: key("channel3") })).status).toBe(401);
    expect((await fetch(`${sellers.url}/reviews/v1/reviews/esp-1001`, { headers: key("reviews") })).status).toBe(200);
    const unauthorized = await fetch(`${sellers.url}/reviews/v1/reviews/esp-1001`);
    expect(await unauthorized.json()).toEqual({ error: "unauthorized", message: "Missing or invalid x-api-key" });
    expect((await fetch(`${sellers.url}/health`)).status).toBe(200);
  });
});

describe("demo sellers: channel3", () => {
  it("returns Channel3-shaped products", async () => {
    const { status, json } = await search({ query: "quiet espresso machine", limit: 5 });
    expect(status).toBe(200);
    expect(json.products).toHaveLength(5);
    expect(json.next_page_token).toBe("5");
    const first = json.products[0];
    expect(first?.id).toBe("esp-1005");
    expect(first).toMatchObject({
      title: "Steamwell Quiet Brew Espresso Machine",
      brand: "Steamwell",
      brands: [{ id: "brand_steamwell", name: "Steamwell" }],
      category: { slug: "espresso-machines" },
      key_features: expect.arrayContaining(["Whisper-quiet 52 dB operation"]),
    });
    expect(first?.images[0].url).toMatch(/^data:image\/svg\+xml/);
    expect(first?.offers[0]).toEqual({
      url: "https://homebarista.example/products/steamwell-quiet-brew-espresso-machine",
      domain: "homebarista.example",
      price: { amount: 329, price: 329, compare_at_price: null, currency: "USD" },
      availability: "InStock",
      condition: "new",
      max_commission_rate: 0.06,
    });
    expect(first?.offers[1]).toMatchObject({ availability: "OutOfStock" });
  });

  it("filters by price (both filter spellings), limits and pages", async () => {
    const capped = await search({ query: "standing desk", limit: 30, filters: { price: { max: 300 } } });
    const prices = capped.json.products.map((p) => Math.min(...p.offers.filter((o: any) => o.availability === "InStock").map((o: any) => o.price.amount)));
    expect(prices.length).toBeGreaterThan(0);
    expect(prices.every((p) => p <= 300)).toBe(true);
    const same = await search({ query: "standing desk", limit: 30, filters: { price: { max_price: 300 } } });
    expect(same.json.products.map((p) => p.id)).toEqual(capped.json.products.map((p) => p.id));
    const floor = await search({ query: "standing desk", limit: 30, filters: { price: { min_price: 700 } } });
    expect(floor.json.products.every((p) => p.offers[0].price.amount >= 700)).toBe(true);

    const page1 = await search({ query: "headphones", limit: 4 });
    expect(page1.json.products).toHaveLength(4);
    expect(page1.json.next_page_token).toBe("4");
    const page2 = await search({ query: "headphones", limit: 4, page_token: "4" });
    expect(page2.json.products.map((p) => p.id)).not.toContain(page1.json.products[0]?.id);
  });

  it("finds every category and nothing for nonsense", () => {
    for (const [query, prefix] of [["espresso machine", "esp-"], ["wireless earbuds", "hp-"], ["sit-stand desk", "desk-"], ["trail running shoes", "run-"]] as const) {
      const ids = searchCatalog({ query, limit: 30 }).products.map((p) => p.id);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id.startsWith(prefix))).toBe(true);
    }
    expect(searchCatalog({ query: "zebra saddle", limit: 10 })).toEqual({ products: [], next_page_token: null });
  });

  it("validates input and 404s unknown products like the real API", async () => {
    expect((await search({ limit: 5 })).status).toBe(400);
    expect((await search({ query: "desk", limit: 31 })).status).toBe(400);
    const missing = await fetch(`${sellers.url}/channel3/v1/products/nope`, { headers: key("channel3") });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ detail: "Product not found" });
  });

  it("keeps the catalog realistic", () => {
    expect(PRODUCTS).toHaveLength(40);
    expect(new Set(PRODUCTS.map((p) => p.id)).size).toBe(40);
    for (const p of PRODUCTS) {
      expect(p.offers.length).toBeGreaterThan(0);
      expect(p.offers.every((o) => o.domain.endsWith(".example") && o.priceCents >= 5_000 && o.priceCents <= 150_000)).toBe(true);
      expect(p.offers.some((o) => o.inStock)).toBe(true);
      expect(p.rating).toBeGreaterThanOrEqual(3.5);
      expect(p.rating).toBeLessThanOrEqual(4.9);
    }
  });
});

describe("demo sellers: pricewatch", () => {
  it("returns deterministic 30-day stats that agree with each product's trend", async () => {
    const url = `${sellers.url}/pricewatch/v1/history/esp-1001`;
    const a = (await (await fetch(url, { headers: key("pricewatch") })).json()) as ReturnType<typeof priceHistory>;
    const b = (await (await fetch(url, { headers: key("pricewatch") })).json()) as ReturnType<typeof priceHistory>;
    expect(a).toEqual(b);
    expect(a).toMatchObject({ product_id: "esp-1001", currency: "USD", window_days: 30, current: 449, current_status: "low" });
    expect(a?.points).toHaveLength(30);
    expect(a?.points.at(-1)?.price).toBe(449);
    expect(a!.min).toBeLessThanOrEqual(a!.current);
    expect(a!.max).toBeGreaterThanOrEqual(a!.mean);
    for (const p of PRODUCTS) expect(priceHistory(p.id)?.current_status).toBe(p.trend);
  });

  it("models untracked products only when given a current price", async () => {
    const unknown = await fetch(`${sellers.url}/pricewatch/v1/history/c3_real_123`, { headers: key("pricewatch") });
    expect(unknown.status).toBe(404);
    const hinted = await fetch(`${sellers.url}/pricewatch/v1/history/c3_real_123?current_price=99.5`, { headers: key("pricewatch") });
    expect(hinted.status).toBe(200);
    expect(await hinted.json()).toMatchObject({ product_id: "c3_real_123", current: 99.5 });
  });
});

describe("demo sellers: reviews", () => {
  it("returns a consistent rating summary and snippets", async () => {
    const res = await fetch(`${sellers.url}/reviews/v1/reviews/esp-1001`, { headers: key("reviews") });
    const body = (await res.json()) as ReturnType<typeof reviewsFor>;
    expect(body).toEqual(reviewsFor("esp-1001"));
    expect(body).toMatchObject({ product_id: "esp-1001", rating: 4.7, count: 1284 });
    const dist = body.distribution;
    const total = dist["1"] + dist["2"] + dist["3"] + dist["4"] + dist["5"];
    expect(total).toBe(1284);
    const mean = (dist["1"] + 2 * dist["2"] + 3 * dist["3"] + 4 * dist["4"] + 5 * dist["5"]) / total;
    expect(Math.abs(mean - 4.7)).toBeLessThan(0.02);
    expect(body.reviews).toHaveLength(3);
    expect(body.highlights.pros.length).toBeGreaterThan(0);
  });

  it("splits FLAKY_RATE into 1/2 errors, 1/3 empty and 1/6 malformed", () => {
    const draw = createFlaky(0.3, 42);
    const counts = { ok: 0, error: 0, empty: 0, malformed: 0 };
    for (let i = 0; i < 20_000; i++) counts[draw()] += 1;
    expect(counts.error / 20_000).toBeCloseTo(0.15, 1);
    expect(counts.empty / 20_000).toBeCloseTo(0.1, 1);
    expect(counts.malformed / 20_000).toBeCloseTo(0.05, 1);
    const again = createFlaky(0.3, 42);
    const replay = createFlaky(0.3, 42);
    expect(Array.from({ length: 50 }, () => again())).toEqual(Array.from({ length: 50 }, () => replay()));
    expect(Array.from({ length: 100 }, createFlaky(0, 1)).every((o) => o === "ok")).toBe(true);
  });

  it("serves each flaky outcome over HTTP, reproducibly with a seed", async () => {
    const flaky = await startSellers({ port: 4411, host: "127.0.0.1", flakyRate: 1, seed: 7 });
    try {
      const outcomes: string[] = [];
      for (let i = 0; i < 12; i++) {
        const res = await fetch(`${flaky.url}/reviews/v1/reviews/hp-2001`, { headers: key("reviews") });
        const text = await res.text();
        if (res.status === 500) outcomes.push("error");
        else {
          expect(res.headers.get("content-type")).toContain("application/json");
          let parsed: { reviews?: unknown[] } | null = null;
          try {
            parsed = JSON.parse(text) as { reviews?: unknown[] };
          } catch {
            outcomes.push("malformed");
            continue;
          }
          expect(parsed?.reviews).toEqual([]);
          outcomes.push("empty");
        }
      }
      const draw = createFlaky(1, 7);
      expect(outcomes).toEqual(Array.from({ length: 12 }, () => draw()));
      expect(new Set(outcomes)).toEqual(new Set(["error", "empty", "malformed"]));
    } finally {
      await flaky.close();
    }
  });
});

describe("demoSellers", () => {
  const base = { sellersBaseUrl: "http://localhost:4030/", channel3ApiKey: null, sellerEmails: { channel3: null, pricewatch: "pw@sandbox.example", reviews: null } };

  it("lists the three local demo sellers", () => {
    const list = demoSellers(base);
    expect(list.map((s) => s.id)).toEqual(["channel3", "pricewatch", "reviews"]);
    expect(list.map((s) => s.baseUrl)).toEqual(["http://localhost:4030/channel3", "http://localhost:4030/pricewatch", "http://localhost:4030/reviews"]);
    expect(list.map((s) => s.apiKey)).toEqual(["demo-channel3-key", "demo-pricewatch-key", "demo-reviews-key"]);
    expect(list.map((s) => s.paypalEmail)).toEqual(["channel3@sellers.402fiatality.example", "pw@sandbox.example", "reviews@sellers.402fiatality.example"]);
    expect(list.flatMap((s) => s.endpoints.map((e) => `${e.method} ${e.path} ${e.priceMicros}`))).toEqual([
      `POST /v1/search ${DEMO_PRICES.search}`,
      `GET /v1/products/:id ${DEMO_PRICES.product}`,
      `GET /v1/history/:productId ${DEMO_PRICES.history}`,
      `GET /v1/reviews/:productId ${DEMO_PRICES.reviews}`,
    ]);
    expect(list[0]?.voidRules).toEqual({ emptyResultPaths: ["products"] });
    expect(list[2]?.voidRules).toEqual({ emptyResultPaths: ["reviews"] });
    for (const s of list) {
      expect(s.id).toMatch(SELLER_ID_PATTERN);
      expect(s.authHeader).toBe("x-api-key");
      expect(voidRulesSchema.partial().safeParse(s.voidRules).success).toBe(true);
      expect(s.endpoints.every((e) => e.priceMicros >= 1 && e.priceMicros <= 10_000_000 && e.description)).toBe(true);
    }
  });

  it("points channel3 at the real Channel3 API when a key is set", () => {
    const [channel3, pricewatch] = demoSellers({ ...base, channel3ApiKey: "c3-live-key" });
    expect(channel3).toMatchObject({
      id: "channel3",
      name: "Channel3",
      baseUrl: CHANNEL3_API_URL,
      authHeader: "x-api-key",
      apiKey: "c3-live-key",
      voidRules: { emptyResultPaths: ["products"], timeoutMs: 15_000 },
    });
    expect(CHANNEL3_API_URL).toBe("https://api.trychannel3.com");
    expect(channel3?.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["POST /v1/search", "GET /v1/products/:id"]);
    expect(pricewatch?.baseUrl).toBe("http://localhost:4030/pricewatch");
  });
});
