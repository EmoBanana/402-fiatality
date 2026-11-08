/** Small async and parsing helpers shared by the x402 client and the runner. */
import type { Micros } from "@p402/shared";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The run was stopped", "AbortError");
}

/** `signal` plus a timeout, for one request. */
export function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Decimal micros string (or safe integer) -> number; null when it isn't one. */
export function parseMicros(value: unknown): Micros | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** How long to wait before retrying a paused tab: Retry-After (seconds or HTTP date), then the 402 hint. */
export function retryDelayMs(retryAfter: string | null, hintSec: number | undefined, fallbackSec = 5): number {
  let ms = fallbackSec * 1_000;
  const header = retryAfter?.trim();
  if (header && /^\d+(\.\d+)?$/.test(header)) ms = Number(header) * 1_000;
  else if (header && !Number.isNaN(Date.parse(header))) ms = Date.parse(header) - Date.now();
  else if (typeof hintSec === "number" && Number.isFinite(hintSec)) ms = hintSec * 1_000;
  return Math.min(30_000, Math.max(250, Math.round(ms)));
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as { cause?: unknown }).cause;
    return cause instanceof Error && cause.message && !err.message.includes(cause.message) ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
