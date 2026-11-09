/**
 * Seller listings for the gateway's demo seeder (`ctx.demoSellers(ctx.config)`). With CHANNEL3_API_KEY set,
 * `channel3` points at the real Channel3 API instead of the built-in demo catalog.
 */
import type { DemoSellersFn } from "@p402/gateway/context";
import type { SellerCreateDTO } from "@p402/shared";
import { demoApiKey, type DemoSellerId } from "./app";

/** List prices in micro-dollars. */
export const DEMO_PRICES = {
  search: 5_000,
  product: 2_000,
  history: 10_000,
  reviews: 3_000,
} as const;

export const CHANNEL3_API_URL = "https://api.trychannel3.com";

const CHANNEL3_ENDPOINTS: SellerCreateDTO["endpoints"] = [
  {
    method: "POST",
    path: "/v1/search",
    priceMicros: DEMO_PRICES.search,
    description: "Product search across merchants: text query, price filters, offers with live prices.",
  },
  {
    method: "GET",
    path: "/v1/products/:id",
    priceMicros: DEMO_PRICES.product,
    description: "One product with description, key features and every merchant offer.",
  },
];

export const demoSellers: DemoSellersFn = (config) => {
  const base = config.sellersBaseUrl.replace(/\/+$/, "");
  const email = (id: DemoSellerId) => config.sellerEmails[id] ?? `${id}@sellers.402fiatality.example`;
  const local = (id: DemoSellerId) => ({ baseUrl: `${base}/${id}`, authHeader: "x-api-key", apiKey: demoApiKey(id), paypalEmail: email(id) });

  const channel3: SellerCreateDTO = config.channel3ApiKey
    ? {
        id: "channel3",
        name: "Channel3",
        baseUrl: CHANNEL3_API_URL,
        authHeader: "x-api-key",
        apiKey: config.channel3ApiKey,
        paypalEmail: email("channel3"),
        voidRules: { emptyResultPaths: ["products"], timeoutMs: 15_000 },
        endpoints: CHANNEL3_ENDPOINTS,
      }
    : {
        id: "channel3",
        name: "Channel3 demo catalog",
        ...local("channel3"),
        voidRules: { emptyResultPaths: ["products"] },
        endpoints: CHANNEL3_ENDPOINTS,
      };

  return [
    channel3,
    {
      id: "pricewatch",
      name: "PriceWatch",
      ...local("pricewatch"),
      voidRules: {},
      endpoints: [
        {
          method: "GET",
          path: "/v1/history/:productId",
          priceMicros: DEMO_PRICES.history,
          description: "30-day price history: current, min, max, mean, std and whether today's price is low, typical or high.",
        },
      ],
    },
    {
      id: "reviews",
      name: "ReviewPulse",
      ...local("reviews"),
      voidRules: { emptyResultPaths: ["reviews"] },
      endpoints: [
        {
          method: "GET",
          path: "/v1/reviews/:productId",
          priceMicros: DEMO_PRICES.reviews,
          description: "Rating summary, star distribution, pros and cons, and recent review snippets.",
        },
      ],
    },
  ];
};
