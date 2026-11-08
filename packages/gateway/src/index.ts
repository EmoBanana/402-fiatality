/** Gateway entry point (`npm run dev` runs it with tsx watch from packages/gateway). */
import { warmUp } from "@p402/ai";
import { recoverInterruptedRuns } from "./agents/runs";
import { APP_VERSION, ConfigError, loadConfig, loadDotEnv, type AppConfig } from "./config";
import { createContext } from "./context";
import { recoverPendingVouchers } from "./paywall/ledger";
import { recoverInterruptedReviews } from "./review/runner";
import { seedDemo } from "./seed";
import { buildServer } from "./server";
import { createServices } from "./services";

const SHUTDOWN_GRACE_MS = 10_000;

function readConfig(): AppConfig {
  loadDotEnv();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const ctx = createContext(config, createServices(config));
  const log = ctx.log;

  const recovered = {
    vouchers: recoverPendingVouchers(ctx),
    reviews: recoverInterruptedReviews(ctx),
    runs: recoverInterruptedRuns(ctx),
  };
  if (recovered.vouchers + recovered.reviews + recovered.runs > 0) log.warn(recovered, "cleaned up work interrupted by the last shutdown");

  const app = await buildServer(ctx);
  if (config.demo) {
    const seeded = await seedDemo(ctx);
    log.info(`demo data: Northwind Research + ${seeded.sellers.length} seller(s)${seeded.failed.length ? `, skipped ${seeded.failed.join(", ")}` : ""}`);
  }
  ctx.settlement.start();
  await app.listen({ host: config.host, port: config.port });

  log.info(
    `402 Fiatality gateway ${APP_VERSION} on ${config.publicBaseUrl} · web ${config.serveWeb ? config.publicBaseUrl : config.webBaseUrl} · ` +
      `PayPal ${config.paypal.mode} · LLM ${ctx.ai.llm.provider} (${ctx.ai.llm.model}) · ${config.demo ? "demo mode" : "admin token required"}`,
  );
  // Load the local model now so the first AI review doesn't spend its 45 s budget on a cold start.
  if (ctx.ai.llm.provider !== "mock") {
    void warmUp(ctx.ai.llm).then((ready) => log.info(ready ? `${ctx.ai.llm.model} is loaded` : `${ctx.ai.llm.model} did not warm up; check ollama`));
  }

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log.info(`${signal}: shutting down`);
    setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS).unref();
    try {
      ctx.settlement.stop();
      await app.close();
    } catch (err) {
      log.error({ err }, "error while shutting down");
    } finally {
      ctx.db.close();
    }
    process.exit(0);
  };
  process.once("SIGINT", (signal) => void shutdown(signal));
  process.once("SIGTERM", (signal) => void shutdown(signal));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
