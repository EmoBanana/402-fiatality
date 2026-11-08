/** Health, config, the demo clock and dashboard metrics. */
import type { ClockDTO, ConfigDTO, HealthDTO } from "@p402/shared";
import { z } from "zod";
import { MAX_ADVANCE_MS } from "../clock";
import { APP_VERSION } from "../config";
import { AppError, type AppContext, type LlmHealth, type RoutePlugin } from "../context";
import { parseInput } from "../http/errors";
import { metricsSummary, timeseries } from "../metrics/metrics";

const LLM_HEALTH_TIMEOUT_MS = 1_500;
const LLM_HEALTH_TTL_MS = 10_000;

const healthCache = new WeakMap<AppContext, { at: number; value: Promise<LlmHealth> }>();

/** LLM reachability, cached ~10 s, bounded by a short timeout, never throws. */
export function llmHealth(ctx: AppContext): Promise<LlmHealth> {
  const cached = healthCache.get(ctx);
  if (cached && Date.now() - cached.at < LLM_HEALTH_TTL_MS) return cached.value;
  const value = (async (): Promise<LlmHealth> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer within ${LLM_HEALTH_TIMEOUT_MS} ms`)), LLM_HEALTH_TIMEOUT_MS);
      });
      const health = await Promise.race([ctx.ai.llm.health(), timeout]);
      return { reachable: Boolean(health.reachable), model: health.model || ctx.ai.llm.model, detail: health.detail };
    } catch (err) {
      return { reachable: false, model: ctx.ai.llm.model, detail: (err as Error).message };
    } finally {
      clearTimeout(timer);
    }
  })();
  healthCache.set(ctx, { at: Date.now(), value });
  return value;
}

export function configDTO(ctx: AppContext): ConfigDTO {
  return {
    paypalMode: ctx.config.paypal.mode,
    currency: "USD",
    demo: ctx.config.demo,
    publicBaseUrl: ctx.config.publicBaseUrl,
    llm: { provider: ctx.ai.llm.provider, model: ctx.ai.llm.model },
  };
}

const advanceSchema = z.object({ ms: z.number().int().min(1).max(MAX_ADVANCE_MS) });

const timeseriesQuery = z.object({
  minutes: z.coerce.number().int().min(1).max(10_080).default(60),
  bucket: z.coerce.number().int().min(1).max(86_400).default(60),
});

export const systemRoutes: RoutePlugin = async (app, { ctx }) => {
  app.get("/api/health", async (): Promise<HealthDTO> => {
    const { paypal } = ctx.config;
    const llm = await llmHealth(ctx);
    return {
      ok: true,
      version: APP_VERSION,
      paypal: { mode: paypal.mode, configured: paypal.mode === "mock" || Boolean(paypal.clientId && paypal.clientSecret) },
      llm: { provider: ctx.ai.llm.provider, model: llm.model, reachable: llm.reachable, ...(llm.detail ? { detail: llm.detail } : {}) },
      demo: ctx.config.demo,
      now: ctx.clock.now(),
    };
  });

  app.get("/api/config", async () => configDTO(ctx));

  app.get("/api/clock", async (): Promise<ClockDTO> => ctx.clock.dto());

  app.post("/api/clock/advance", async (request): Promise<ClockDTO> => {
    if (!ctx.config.demo) throw new AppError(403, "demo_only", "The clock can only be fast-forwarded in demo mode (DEMO_MODE=1).");
    const { ms } = parseInput(advanceSchema, request.body);
    const clock = ctx.clock.advance(ms);
    ctx.bus.emit("clock.advanced", clock);
    try {
      await ctx.settlement.tick();
    } catch (err) {
      request.log.error({ err }, "settlement tick after clock advance failed");
    }
    return ctx.clock.dto();
  });

  app.get("/api/metrics/summary", async () => metricsSummary(ctx));

  app.get("/api/metrics/timeseries", async (request) => {
    const { minutes, bucket } = parseInput(timeseriesQuery, request.query);
    return timeseries(ctx, minutes, bucket);
  });
};
