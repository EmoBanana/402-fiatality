/**
 * The Fastify app: global security (helmet, CORS, /api rate limit, admin guard), error and 404 handling for
 * every route (including the settlement routes), the REST API, the paywall, /ws, and the built web app.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import { AppError, type AppContext, type RoutePlugin } from "./context";
import { createCore, type CoreOptions } from "./core";
import { errorHandler } from "./http/errors";
import { ADMIN_HEADER, adminGuard, isApiPath, isServicePath, routePath, webPageHeaders } from "./http/guards";
import { paywallRoutes } from "./paywall/route";
import { agentRoutes } from "./routes/agents";
import { aiRoutes } from "./routes/ai";
import { ledgerRoutes } from "./routes/ledger";
import { sellerRoutes } from "./routes/sellers";
import { settlementRoutes } from "./routes/settlement";
import { systemRoutes } from "./routes/system";
import { tabRoutes } from "./routes/tabs";
import { createEventRoutes } from "./ws";

/**
 * Requests per minute per client on /api (the paywall has per-tab policy limits instead). Generous: in dev the
 * web app (through the Vite proxy) and in-process agents all arrive from 127.0.0.1.
 */
export const API_RATE_LIMIT_PER_MINUTE = 3_000;

export interface BuildServerOptions extends CoreOptions {
  /** How often /ws may push a `metrics` snapshot (default 1000 ms). */
  metricsIntervalMs?: number;
  /** /api requests per minute per client (default API_RATE_LIMIT_PER_MINUTE). */
  apiRateLimit?: number;
}

export async function buildServer(ctx: AppContext, opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const core = createCore(ctx, opts);
  const app = Fastify({
    loggerInstance: ctx.log,
    // Per-request info lines would drown the log at agent call rates: onResponse logs them at debug.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
  }) as unknown as FastifyInstance;

  app.setErrorHandler(errorHandler);
  app.addHook("onResponse", async (request, reply) => {
    request.log.debug(
      { method: request.method, url: request.url.split("?")[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      "request",
    );
  });

  // CSP and COOP are set per page in webPageHeaders: JSON needs neither, and the /paypal return page must
  // keep window.opener to report back to the console that opened the PayPal popup.
  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    // HSTS only means something when the gateway is actually served over https.
    hsts: ctx.config.publicBaseUrl.startsWith("https://") ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  });
  app.addHook("onSend", webPageHeaders(ctx.config.publicBaseUrl));
  await app.register(cors, {
    origin: [ctx.config.webBaseUrl],
    methods: ["GET", "HEAD", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["accept", "content-type", ADMIN_HEADER, "payment-signature"],
    exposedHeaders: ["payment-required", "payment-response", "retry-after"],
    maxAge: 600,
  });
  await app.register(rateLimit, {
    global: true,
    max: opts.apiRateLimit ?? API_RATE_LIMIT_PER_MINUTE,
    timeWindow: "1 minute",
    // The key is computed before allowList runs, so it must cope with requests that have no socket address.
    keyGenerator: (request) => request.ip || request.socket?.remoteAddress || "local",
    allowList: (request) => !isApiPath(routePath(request)),
    errorResponseBuilder: (_request, context) => new AppError(429, "rate_limited", `Too many requests: try again in ${context.after}.`),
  });
  // After CORS and the rate limit, so a 401 still carries CORS headers and floods are limited first.
  app.addHook("onRequest", adminGuard(ctx.config));
  await app.register(websocket, { options: { maxPayload: 4 * 1024 } });

  const routes: RoutePlugin[] = [
    systemRoutes,
    sellerRoutes,
    tabRoutes,
    ledgerRoutes,
    agentRoutes,
    aiRoutes,
    settlementRoutes,
    paywallRoutes,
    createEventRoutes({ metricsIntervalMs: opts.metricsIntervalMs }),
  ];
  for (const plugin of routes) await app.register(plugin, { ctx });

  const indexHtml = join(ctx.config.webDistDir, "index.html");
  const serveWeb = ctx.config.serveWeb && existsSync(indexHtml);
  if (ctx.config.serveWeb && !serveWeb) ctx.log.warn(`${indexHtml} is missing: run \`npm run build\` to serve the web app.`);
  if (serveWeb) await app.register(fastifyStatic, { root: ctx.config.webDistDir, wildcard: false });

  app.setNotFoundHandler(async (request, reply) => {
    if (serveWeb && (request.method === "GET" || request.method === "HEAD") && !isServicePath(request.url)) {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    }
    const path = request.url.split("?")[0];
    return reply.code(404).send({ error: "not_found", message: `No route for ${request.method} ${path}.` });
  });

  app.addHook("onClose", async () => core.shutdown());
  return app;
}
