/**
 * /ws: every GatewayEvent as JSON. A `metrics` snapshot goes out on connect, then at most once per interval
 * while something changed. Browsers may only connect from the web app's origin (or the gateway's own).
 */
import type { FastifyReply, FastifyRequest } from "fastify";
// Types for the `websocket: true` route option; server.ts registers the plugin itself.
import type {} from "@fastify/websocket";
import type { AppContext, RoutePlugin } from "./context";
import { metricsSummary } from "./metrics/metrics";
import { isLocalHostname } from "./sellers/ssrf";

export const METRICS_INTERVAL_MS = 1_000;
/** A client this far behind is dropped rather than buffered without bound. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const OPEN = 1;

/** The part of a `ws` WebSocket we use (the package ships no types). */
interface Socket {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "close" | "error" | "message", listener: (...args: unknown[]) => void): void;
}

export function originAllowed(ctx: AppContext, origin: string | undefined): boolean {
  if (!origin) return true; // not a browser
  if (origin === ctx.config.webBaseUrl || origin === ctx.config.publicBaseUrl) return true;
  if (!ctx.config.demo) return false;
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export function createEventRoutes(opts: { metricsIntervalMs?: number } = {}): RoutePlugin {
  return async (app, { ctx }) => {
    const sockets = new Set<Socket>();
    let dirty = false;

    const send = (socket: Socket, text: string) => {
      if (socket.readyState !== OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        sockets.delete(socket);
        socket.close(1013, "client too slow");
        return;
      }
      socket.send(text);
    };

    const unsubscribe = ctx.bus.subscribe((event) => {
      if (event.type !== "metrics") dirty = true;
      if (sockets.size === 0) return;
      const text = JSON.stringify(event);
      for (const socket of sockets) send(socket, text);
    });

    const timer = setInterval(() => {
      if (!dirty || sockets.size === 0) return;
      dirty = false;
      try {
        ctx.bus.emit("metrics", metricsSummary(ctx));
      } catch (err) {
        ctx.log.warn({ err }, "metrics snapshot failed");
      }
    }, opts.metricsIntervalMs ?? METRICS_INTERVAL_MS);
    timer.unref();

    app.addHook("onClose", async () => {
      clearInterval(timer);
      unsubscribe();
      for (const socket of sockets) socket.close(1001, "gateway shutting down");
      sockets.clear();
    });

    const checkOrigin = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!originAllowed(ctx, request.headers.origin)) {
        return reply.code(403).send({ error: "forbidden", message: "This origin may not open the event stream." });
      }
    };

    app.get("/ws", { websocket: true, preValidation: checkOrigin }, (raw) => {
      const socket = raw as unknown as Socket;
      sockets.add(socket);
      const drop = () => sockets.delete(socket);
      socket.on("close", drop);
      socket.on("error", drop);
      send(socket, JSON.stringify({ type: "metrics", at: ctx.clock.now(), data: metricsSummary(ctx) }));
    });
  };
}
