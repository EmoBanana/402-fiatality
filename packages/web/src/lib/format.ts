/**
 * Display formatting. Money comes from @p402/shared so sub-cent amounts keep their precision
 * (formatUsd(5_000) -> "$0.005"); everything here is en-US, tabular-friendly and side-effect free.
 * Pass the gateway clock's `now` (useLatestEvent("clock.advanced") / api.clock.get()) when the demo clock
 * may be fast-forwarded.
 */
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

/** 4.4812 -> "4.48%" (digits = decimals). */
export function formatPct(value: number, digits = 2): string {
  return `${value.toFixed(digits)}%`;
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
  const abs = Math.abs(ms);
  if (abs < 1_000) return `${Math.round(abs)} ms`;
  if (abs < 60_000) return `${Math.round(abs / 1_000)} s`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min`;
  if (abs < 86_400_000) {
    const h = Math.floor(abs / 3_600_000);
    const m = Math.round((abs % 3_600_000) / 60_000);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(abs / 86_400_000);
  const h = Math.round((abs % 86_400_000) / 3_600_000);
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
  if (!match) return model;
  return match[2] ? `Gemma ${match[1]} · ${match[2]}` : `Gemma ${match[1]}`;
}
