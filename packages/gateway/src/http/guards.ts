/** Admin token guard for mutating /api calls, and the security headers of the served web app. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, onRequestHookHandler, onSendHookHandler } from "fastify";
import { AppError, type AppConfig } from "../context";

export const ADMIN_HEADER = "x-p402-admin";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Paths that belong to the API, the paywall, the event stream and the PayPal return pages (never the SPA). */
export function isServicePath(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return (
    path === "/api" ||
    path.startsWith("/api/") ||
    path.startsWith("/s/") ||
    path === "/ws" ||
    path.startsWith("/ws/") ||
    path === "/paypal" ||
    path.startsWith("/paypal/")
  );
}

/** Constant-time comparison of two secrets of any length (both are hashed to 32 bytes first). */
export function secretsEqual(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b) && given.length === expected.length;
}

/** With DEMO_MODE=0 every non-GET/HEAD/OPTIONS request under /api needs `x-p402-admin: <ADMIN_TOKEN>`. */
export function adminGuard(config: Pick<AppConfig, "demo" | "adminToken">): onRequestHookHandler {
  return async (request: FastifyRequest) => {
    if (config.demo || SAFE_METHODS.has(request.method)) return;
    const path = request.url.split("?")[0] ?? "";
    if (path !== "/api" && !path.startsWith("/api/")) return;
    const given = request.headers[ADMIN_HEADER];
    if (typeof given !== "string" || !config.adminToken || !secretsEqual(given, config.adminToken)) {
      throw new AppError(401, "unauthorized", `This gateway is not in demo mode: send the ${ADMIN_HEADER} header with the admin token.`);
    }
  };
}

/**
 * CSP for the built web app (npm start). The app ships no inline scripts; AG Grid, AG Charts and Bryntum inject
 * styles; product images come from merchants over https; the event stream is same-origin WebSocket.
 */
export function webContentSecurityPolicy(publicBaseUrl: string): string {
  const wsOrigin = publicBaseUrl.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${wsOrigin}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

/** Adds the web app's CSP (and a popup-friendly COOP for the PayPal approval window) to HTML pages it serves. */
export function webPageHeaders(publicBaseUrl: string): onSendHookHandler {
  const csp = webContentSecurityPolicy(publicBaseUrl);
  return async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (isServicePath(request.url)) return payload;
    const type = reply.getHeader("content-type");
    if (typeof type === "string" && type.startsWith("text/html")) {
      void reply.header("content-security-policy", csp);
      void reply.header("cross-origin-opener-policy", "same-origin-allow-popups");
    }
    return payload;
  };
}
