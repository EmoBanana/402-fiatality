/**
 * Forwarding a paid call to the seller (SPEC §5.3 step 6). node:http instead of fetch so that every connection
 * goes through `guardedLookup` (the SSRF guard re-checks the addresses actually dialed), with a hard timeout
 * from the seller's void rules and a 2 MB response cap. Only allow-listed request headers are forwarded.
 */
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";
import zlib from "node:zlib";
import { checkSellerUrlShape, guardedLookup, isLocalHostname, normalizeHostname } from "../sellers/ssrf";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Request headers an agent may pass through to a seller. Everything else (auth, cookies, x402) is dropped. */
const FORWARDED_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "user-agent"] as const;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

export interface ForwardRequest {
  baseUrl: string;
  /** Path + query relative to the seller's base URL; already checked by isForwardablePath. */
  pathWithQuery: string;
  method: string;
  clientHeaders: IncomingHttpHeaders;
  body: Buffer;
  timeoutMs: number;
  demo: boolean;
  /** Injected seller credential, e.g. { header: "x-api-key", value: "..." }. */
  auth: { header: string; value: string } | null;
  voucherId: string;
}

export type ForwardResult =
  | { kind: "response"; status: number; contentType: string | null; body: Buffer; latencyMs: number }
  | { kind: "timeout"; latencyMs: number }
  | { kind: "unreachable"; latencyMs: number; detail: string }
  | { kind: "too_large"; latencyMs: number; status: number };

export function forwardHeaders(req: Pick<ForwardRequest, "clientHeaders" | "auth" | "voucherId" | "body" | "method">): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.clientHeaders[name];
    if (typeof value === "string") headers[name] = value;
  }
  headers["accept-encoding"] = "identity";
  headers["x-p402-voucher"] = req.voucherId;
  if (req.method !== "GET" && req.method !== "HEAD") headers["content-length"] = String(req.body.length);
  if (req.auth) headers[req.auth.header] = req.auth.value;
  return headers;
}

function decode(body: Buffer, encoding: string | undefined): Buffer {
  const opts = { maxOutputLength: MAX_RESPONSE_BYTES };
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(body, opts);
    case "br":
      return zlib.brotliDecompressSync(body, opts);
    case "deflate":
      return zlib.inflateSync(body, opts);
    default:
      return body;
  }
}

export function forward(req: ForwardRequest): Promise<ForwardResult> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);

  let target: URL;
  try {
    target = checkSellerUrlShape(req.baseUrl, req.demo);
  } catch (err) {
    return Promise.resolve({ kind: "unreachable", latencyMs: 0, detail: (err as Error).message });
  }
  const hostname = normalizeHostname(target.hostname);
  const isHttps = target.protocol === "https:";

  return new Promise<ForwardResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const finish = (result: ForwardResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failed = (detail: string) => finish(timedOut ? { kind: "timeout", latencyMs: elapsed() } : { kind: "unreachable", latencyMs: elapsed(), detail });

    const request = (isHttps ? https : http).request(
      {
        protocol: target.protocol,
        hostname,
        port: target.port || undefined,
        path: `${target.pathname.replace(/\/+$/, "")}${req.pathWithQuery}`,
        method: req.method,
        headers: forwardHeaders(req),
        agent: isHttps ? httpsAgent : httpAgent,
        lookup: guardedLookup(req.demo && isLocalHostname(hostname)),
        signal: controller.signal,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        if (Number(res.headers["content-length"]) > MAX_RESPONSE_BYTES) {
          res.destroy();
          finish({ kind: "too_large", latencyMs: elapsed(), status });
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            finish({ kind: "too_large", latencyMs: elapsed(), status });
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          let body: Buffer;
          try {
            body = decode(Buffer.concat(chunks), res.headers["content-encoding"]);
          } catch {
            finish({ kind: "too_large", latencyMs: elapsed(), status });
            return;
          }
          const contentType = res.headers["content-type"];
          finish({ kind: "response", status, contentType: typeof contentType === "string" ? contentType : null, body, latencyMs: elapsed() });
        });
        res.on("error", (err) => failed(err.message));
        res.on("close", () => failed("connection closed before the response ended"));
      },
    );
    request.on("error", (err) => failed((err as Error).message));
    request.end(req.body.length > 0 ? req.body : undefined);
  });
}
