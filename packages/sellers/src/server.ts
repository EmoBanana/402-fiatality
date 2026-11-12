/** `npm run dev -w @p402/sellers`: the three demo seller APIs on SELLERS_PORT (default 4030). */
import { ConfigError, loadConfig, loadDotEnv } from "@p402/gateway/config";
import { startDemoSellers } from "./app";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

try {
  loadDotEnv();
  const config = loadConfig();
  // Only the gateway calls the sellers, at SELLERS_BASE_URL (default http://localhost:<SELLERS_PORT>). When that is
  // loopback, listen there even if HOST=0.0.0.0 opens the gateway: on Render only PORT should face the internet.
  const sellersHost = new URL(config.sellersBaseUrl).hostname.replace(/^\[|\]$/g, "");
  const sellers = await startDemoSellers({
    port: config.sellersPort,
    host: LOOPBACK.has(sellersHost) ? sellersHost : config.host,
    flakyRate: config.flakyRate,
    logRequests: true,
  });
  console.log(
    `Demo sellers on ${sellers.url}: /channel3 (catalog), /pricewatch (price history), /reviews (${Math.round(config.flakyRate * 100)}% flaky)`,
  );
  if (config.channel3ApiKey) {
    console.log("CHANNEL3_API_KEY is set, so the gateway seeds the real Channel3 API; the demo catalog stays available here.");
  }
  const shutdown = () => void sellers.close().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}
