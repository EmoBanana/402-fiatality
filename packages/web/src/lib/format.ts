/**
 * Display formatting. Money comes from @p402/shared so sub-cent amounts keep their precision
 * (formatUsd(5_000) -> "$0.005"); everything here is en-US, tabular-friendly and side-effect free.
 * Pass the gateway clock's `now` (useLatestEvent("clock.advanced") / api.clock.get()) when the demo clock
 * may be fast-forwarded.
 */
import { dollarsToMicros, type Micros, microsToDollarString, VOID_REASON_LABELS } from "@p402/shared";

export {
  centsToMicros,
  effectiveRatePct,
  formatCents,
  formatUsd,
  MICROS_PER_CENT,
  MICROS_PER_DOLLAR,
  microsToDollarString,
  VOID_REASON_LABELS,
} from "@p402/shared";

const countFormat = new Intl.NumberFormat("en-US");
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const relativeFormat = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

/** 1234 -> "1,234" */
export function formatCount(n: number): string {
  return countFormat.format(n);
}

/**
 * 4.4812 -> "4.48%" (digits = decimals). From 100% up the decimals go and thousands are grouped, so a
 * cents-sized tab's fee rate reads "1,225%" (not "1225.00%") and lines up with "980%" in a column.
 */
export function formatPct(value: number, digits = 2): string {
  const decimals = Math.abs(value) >= 100 ? 0 : digits;
  return `${value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}%`;
}

/** 14:03:21 */
export function formatTime(ms: number): string {
  return timeFormat.format(ms);
}

/** Nov 8, 2026 */
export function formatDate(ms: number): string {
  return dateFormat.format(ms);
}

/** Nov 8, 14:03 */
export function formatDateTime(ms: number): string {
  return dateTimeFormat.format(ms);
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
  ["second", 1_000],
];

/** "in 3 days", "2 minutes ago", "now". */
export function formatRelative(ms: number, now: number = Date.now()): string {
  const diff = ms - now;
  if (Math.abs(diff) < 5_000) return "now";
  for (const [unit, size] of UNITS) {
    if (Math.abs(diff) >= size || unit === "second") return relativeFormat.format(Math.round(diff / size), unit);
  }
  return "now";
}

/** 850 -> "850 ms", 12_000 -> "12 s", 3_660_000 -> "1 h 1 min", 3 days -> "3 d". */
export function formatDuration(ms: number): string {
  // Round once at the smallest unit shown, then split, so 3 d 23.9 h reads "4 d" (never "3 d 24 h").
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(abs)} ms`;
  const seconds = Math.round(abs / 1_000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(abs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const hours = Math.round(abs / 3_600_000);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return h ? `${d} d ${h} h` : `${d} d`;
}

/** "tab_k3x9q2m1v8p0w7" -> "tab_k3x9…w7" for tight columns (show the full id in a title attribute). */
export function shortId(id: string, head = 4, tail = 2): string {
  const [prefix, rest] = id.includes("_") ? [id.slice(0, id.indexOf("_") + 1), id.slice(id.indexOf("_") + 1)] : ["", id];
  if (rest.length <= head + tail + 1) return id;
  return `${prefix}${rest.slice(0, head)}…${rest.slice(-tail)}`;
}

/** "gemma4:12b" -> "Gemma 4 · 12b"; other model names pass through. */
export function modelLabel(model: string): string {
  const match = /^gemma(\d+)(?::(.+))?$/i.exec(model);
  return match ? `Gemma ${match[1]}` : model;
}

/** "1 call", "3 calls"; pass `many` for irregular plurals. Counts are formatted (1,204 calls). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

/**
 * Parse what a person typed into a dollar field ("0.005", "$1,250", "50") into micros. Returns null for
 * empty, malformed or negative input; digits past the 6th decimal are dropped.
 */
export function parseDollars(input: string): Micros | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const micros = dollarsToMicros(trimmed);
    return micros < 0 ? null : micros;
  } catch {
    return null;
  }
}

/** Micros as an editable dollar string: 50_000_000 -> "50.00", 5_000 -> "0.005". */
export function microsToInput(micros: Micros): string {
  return microsToDollarString(micros);
}

/** Readable label for a void reason (falls back to the raw code). */
export function voidReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Voided";
  return (VOID_REASON_LABELS as Record<string, string>)[reason] ?? reason.replace(/_/g, " ");
}
