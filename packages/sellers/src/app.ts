/**
 * One Fastify process serves all three demo sellers, path-prefixed so a single port is enough:
 * `/channel3`, `/pricewatch`, `/reviews`. Each prefix requires `x-api-key: demo-<id>-key`, which only the
 * gateway knows (it injects the seller key when it forwards a paid call).
 */
import { timingSafeEqual } from "node:crypto";
import type { RunningSellers, StartSellersOptions } from "@p402/gateway/context";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { channel3Routes } from "./channel3";
import { pricewatchRoutes } from "./pricewatch";
import { createFlaky, reviewsRoutes } from "./reviews";

export const DEMO_SELLER_IDS = ["channel3", "pricewatch", "reviews"] as const;
export type DemoSellerId = (typeof DEMO_SELLER_IDS)[number];

export function demoApiKey(id: DemoSellerId): string {
  return `demo-${id}-key`;
}

export interface SellersAppOptions {
  /** Share of flaky reviews responses, 0..1 (default 0.3). */
  flakyRate?: number;
  /** Seed for reproducible flakiness. */
  seed?: number;
  /** Print one line per request (dev server). */
  logRequests?: boolean;
}

export function createSellersApp(opts: SellersAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  const flaky = createFlaky(opts.flakyRate ?? 0.3, opts.seed);

  if (opts.logRequests) {
    app.addHook("onResponse", async (request, reply) => {
      console.log(`${request.method} ${request.url.split("?")[0]} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
    });
  }

  app.get("/health", async () => ({ ok: true, sellers: DEMO_SELLER_IDS }));

  const mount = (id: DemoSellerId, routes: (scope: FastifyInstance) => void) =>
    app.register(
      async (scope) => {
        scope.addHook("onRequest", requireApiKey(demoApiKey(id)));
        routes(scope);
      },
      { prefix: `/${id}` },
    );
  mount("channel3", channel3Routes);
  mount("pricewatch", pricewatchRoutes);
  mount("reviews", (scope) => reviewsRoutes(scope, flaky));

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: "not_found", message: `No route for ${request.method} ${request.url.split("?")[0]}` }),
  );
  return app;
}

function requireApiKey(expected: string) {
  const want = Buffer.from(expected);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers["x-api-key"];
    const given = Buffer.from(typeof header === "string" ? header : "");
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return reply.code(401).send({ error: "unauthorized", message: "Missing or invalid x-api-key" });
    }
  };
}

export async function startDemoSellers(opts: StartSellersOptions & { logRequests?: boolean }): Promise<RunningSellers> {
  const app = createSellersApp(opts);
  const host = opts.host ?? "localhost";
  await app.listen({ port: opts.port, host });
  const address = app.server.address();
  const port = typeof address === "object" && address ? address.port : opts.port;
  const shownHost = host === "0.0.0.0" || host === "::" ? "localhost" : host.includes(":") ? `[${host}]` : host;
  return {
    url: `http://${shownHost}:${port}`,
    close: async () => {
      await app.close();
    },
  };
}
