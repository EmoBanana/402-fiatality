/** `npm run dev -w @p402/sellers`: the three demo seller APIs on SELLERS_PORT (default 4030). */
import { ConfigError, loadConfig, loadDotEnv } from "@p402/gateway/config";
import { startDemoSellers } from "./app";

try {
  loadDotEnv();
  const config = loadConfig();
  const sellers = await startDemoSellers({
    port: config.sellersPort,
    host: config.host,
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
