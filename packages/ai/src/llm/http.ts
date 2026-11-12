/** fetch with a timeout, the caller's AbortSignal and LlmError mapping. */
import { LlmError } from "./errors";

export type FetchFn = typeof fetch;

export interface HttpOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: FetchFn;
  /** Who we are talking to, for messages ("Ollama"). */
  service: string;
  /** Appended when the server cannot be reached ("Start it with `ollama serve`."). */
  unreachableHint: string;
  /** Repeat a request answered 500/502/503/504 up to this many times, inside the same timeout (default 0). */
  serverErrorRetries?: number;
  /** First pause before such a retry; it doubles each time (default 500 ms). */
  retryDelayMs?: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  /** Parsed JSON body, or null when the body is not JSON. */
  body: unknown;
  text: string;
}

/** A pooled keep-alive socket the server already closed; the request never reached it, so retry once. */
const STALE_SOCKET = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
/** Server-side failures worth repeating unchanged (Gemini answers a share of Gemma 4 requests with a 500). */
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);

export async function httpJson(url: string, opts: HttpOptions): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  if (opts.signal?.aborted) throw new LlmError("aborted", `${opts.service} request was cancelled`);
  let socketRetried = false;
  let serverRetries = 0;
  for (;;) {
    let result: HttpResult;
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, {
        method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
        headers: {
          accept: "application/json",
          ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal,
      });
      const text = await res.text();
      result = { status: res.status, ok: res.ok, body: parseOrNull(text), text };
    } catch (err) {
      if (opts.signal?.aborted && !timeout.aborted) throw new LlmError("aborted", `${opts.service} request was cancelled`);
      if (timeout.aborted) {
        throw new LlmError("timeout", `${opts.service} did not answer within ${Math.round(opts.timeoutMs / 100) / 10} s`);
      }
      const code = networkCode(err);
      if (!socketRetried && code && STALE_SOCKET.has(code)) {
        socketRetried = true;
        continue;
      }
      throw new LlmError(
        "unreachable",
        `${opts.service} is not reachable at ${originOf(url)}${code ? ` (${code})` : ""}. ${opts.unreachableHint}`,
      );
    }
    if (RETRYABLE_STATUS.has(result.status) && serverRetries < (opts.serverErrorRetries ?? 0)) {
      const delayMs = (opts.retryDelayMs ?? 500) * 2 ** serverRetries;
      serverRetries++;
      if (await pause(delayMs, signal)) continue;
      if (opts.signal?.aborted && !timeout.aborted) throw new LlmError("aborted", `${opts.service} request was cancelled`);
    }
    return result;
  }
}

/** Wait `ms`; false when `signal` fires first (the timeout or the caller), so no retry is started. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = (waited: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(waited);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Server error text from `{ error: "..." }` / `{ error: { message } }` bodies (Gemini wraps one in an array), else the raw text. */
export function serverError(result: HttpResult): string {
  const body = (Array.isArray(result.body) ? result.body[0] : result.body) as { error?: unknown; message?: unknown } | null;
  const err = body?.error;
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  if (typeof body?.message === "string") return body.message;
  return result.text.slice(0, 300) || `HTTP ${result.status}`;
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function parseOrNull(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function networkCode(err: unknown): string | null {
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === "string" ? cause.code : null;
}
