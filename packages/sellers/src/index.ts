// @p402/sellers: demo seller APIs (Channel3-shaped catalog, price history, flaky reviews) and their listings.
import type { StartSellers } from "@p402/gateway/context";
import { startDemoSellers } from "./app";

export { createSellersApp, DEMO_SELLER_IDS, demoApiKey, startDemoSellers, type DemoSellerId, type SellersAppOptions } from "./app";
export { CHANNEL3_API_URL, DEMO_PRICES, demoSellers } from "./demoSellers";

/** Start the three demo sellers on one port (`port: 0` picks a free one). */
export const startSellers: StartSellers = (opts) => startDemoSellers(opts);
