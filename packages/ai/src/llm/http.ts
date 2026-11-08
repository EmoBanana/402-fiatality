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

export async function httpJson(url: string, opts: HttpOptions): Promise<HttpResult> {
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  if (opts.signal?.aborted) throw new LlmError("aborted", `${opts.service} request was cancelled`);
  for (let attempt = 0; ; attempt++) {
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
      return { status: res.status, ok: res.ok, body: parseOrNull(text), text };
    } catch (err) {
      if (opts.signal?.aborted && !timeout.aborted) throw new LlmError("aborted", `${opts.service} request was cancelled`);
      if (timeout.aborted) {
        throw new LlmError("timeout", `${opts.service} did not answer within ${Math.round(opts.timeoutMs / 100) / 10} s`);
      }
      const code = networkCode(err);
      if (attempt === 0 && code && STALE_SOCKET.has(code)) continue;
      throw new LlmError(
        "unreachable",
        `${opts.service} is not reachable at ${originOf(url)}${code ? ` (${code})` : ""}. ${opts.unreachableHint}`,
      );
    }
  }
}

/** Server error text from `{ error: "..." }` / `{ error: { message } }` bodies, else the raw text. */
export function serverError(result: HttpResult): string {
  const body = result.body as { error?: unknown; message?: unknown } | null;
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
