/**
 * Pure data shaping for the Insights page: no React, no DOM. Money stays in integer micros/cents until the
 * last step, where charts get plain dollars.
 */
import {
  captureFeeCents,
  effectiveRatePct,
  MICROS_PER_DOLLAR,
  type SellerDTO,
  type SettlementDTO,
  type TabDTO,
  type TimeseriesPointDTO,
  VOID_REASON_LABELS,
  type VoidReason,
  type VoucherDTO,
} from "@p402/shared";
import { shortId } from "../../lib/format";

const MINUTE = 60_000;

// ---------------------------------------------------------------- ranges

export type RangeId = "1h" | "24h" | "7d";

export interface RangeOption {
  id: RangeId;
  label: string;
  minutes: number;
  /** Bucket size in seconds (GET /api/metrics/timeseries `bucket`). */
  bucketSec: number;
}

export const RANGES: readonly RangeOption[] = [
  { id: "1h", label: "Last hour", minutes: 60, bucketSec: 60 },
  { id: "24h", label: "24 hours", minutes: 24 * 60, bucketSec: 30 * 60 },
  { id: "7d", label: "7 days", minutes: 7 * 24 * 60, bucketSec: 4 * 60 * 60 },
];

export function rangeOption(id: RangeId): RangeOption {
  return RANGES.find((r) => r.id === id) ?? RANGES[0]!;
}

/** Client-side stand-in for GET /api/metrics/timeseries, built from the vouchers we already hold. */
export function aggregateVouchers(vouchers: readonly VoucherDTO[], range: RangeOption, now: number): TimeseriesPointDTO[] {
  const bucket = range.bucketSec * 1000;
  const end = Math.ceil(now / bucket) * bucket;
  const start = end - range.minutes * MINUTE;
  const points: TimeseriesPointDTO[] = [];
  for (let t = start; t < end; t += bucket) points.push({ t, calls: 0, voids: 0, spendMicros: 0, bySeller: {} });
  for (const v of vouchers) {
    if (v.createdAt < start || v.createdAt >= end) continue;
    const point = points[Math.floor((v.createdAt - start) / bucket)];
    if (!point) continue;
    point.calls += 1;
    if (v.status === "voided") {
      point.voids += 1;
    } else {
      point.spendMicros += v.priceMicros;
      point.bySeller[v.sellerId] = (point.bySeller[v.sellerId] ?? 0) + v.priceMicros;
    }
  }
  return points;
}

// ---------------------------------------------------------------- sellers & tabs

/**
 * Stable seller order for color assignment: sorted by id, so a seller keeps its color across reloads and
 * filters (color follows the entity, never its rank). Unknown ids seen in data are appended.
 */
export function sellerOrder(sellers: readonly SellerDTO[], extraIds: Iterable<string> = []): string[] {
  const ids = new Set(sellers.map((s) => s.id));
  for (const id of extraIds) ids.add(id);
  return [...ids].sort();
}

export function sellerNames(sellers: readonly SellerDTO[]): Map<string, string> {
  return new Map(sellers.map((s) => [s.id, s.name]));
}

export function tabLabel(tab: Pick<TabDTO, "id" | "label" | "companyName"> | undefined, tabId: string): string {
  return tab?.label?.trim() || tab?.companyName?.trim() || shortId(tabId);
}

// ---------------------------------------------------------------- spend over time

export interface SpendRow {
  /** Bucket start, epoch ms. */
  t: number;
  /** Axis label for the bucket, e.g. "14:05" or "Nov 8". */
  label: string;
  /** Dollars per seller id. */
  [sellerId: string]: number | string;
}

const timeLabel = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayTimeLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export function bucketLabel(t: number, range: RangeOption): string {
  return range.bucketSec >= 4 * 3600 ? dayTimeLabel.format(t) : timeLabel.format(t);
}

export function spendRows(points: readonly TimeseriesPointDTO[], sellerIds: readonly string[], range: RangeOption): SpendRow[] {
  return points.map((p) => {
    const row: SpendRow = { t: p.t, label: bucketLabel(p.t, range) };
    for (const id of sellerIds) row[id] = (p.bySeller[id] ?? 0) / MICROS_PER_DOLLAR;
    return row;
  });
}

export interface SpendTotals {
  calls: number;
  voids: number;
  spendMicros: number;
  bySeller: Record<string, number>;
}

export function spendTotals(points: readonly TimeseriesPointDTO[]): SpendTotals {
  const totals: SpendTotals = { calls: 0, voids: 0, spendMicros: 0, bySeller: {} };
  for (const p of points) {
    totals.calls += p.calls;
    totals.voids += p.voids;
    totals.spendMicros += p.spendMicros;
    for (const [id, micros] of Object.entries(p.bySeller)) totals.bySeller[id] = (totals.bySeller[id] ?? 0) + micros;
  }
  return totals;
}

// ---------------------------------------------------------------- voids

export interface VoidReasonRow {
  reason: string;
  label: string;
  count: number;
  /** What the voided calls would have cost, in micros. */
  micros: number;
}

export function voidLabel(reason: string | null | undefined): string {
  if (!reason) return "Unspecified";
  return VOID_REASON_LABELS[reason as VoidReason] ?? reason.replace(/_/g, " ");
}

export function voidsByReason(vouchers: readonly VoucherDTO[], since: number): VoidReasonRow[] {
  const rows = new Map<string, VoidReasonRow>();
  for (const v of vouchers) {
    if (v.status !== "voided" || v.createdAt < since) continue;
    const reason = v.voidReason ?? "unspecified";
    const row = rows.get(reason) ?? { reason, label: voidLabel(v.voidReason), count: 0, micros: 0 };
    row.count += 1;
    row.micros += v.priceMicros;
    rows.set(reason, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------- fees

export interface FeeCurvePoint {
  /** Tab size in dollars. */
  dollars: number;
  /** Effective PayPal fee rate in percent (3.49% + $0.49 per capture). */
  rate: number;
  feeCents: number;
}

/**
 * The effective-rate curve for one PayPal capture, `fromCents` (default $1) to `maxDollars`, from the shared
 * fee math. Below $1 it steps one cent at a time, so a log-scaled axis gets an even curve.
 */
export function feeCurve(maxDollars = 100, fromCents = 100): FeeCurvePoint[] {
  const points: FeeCurvePoint[] = [];
  const push = (cents: number) => {
    const feeCents = captureFeeCents(cents);
    points.push({ dollars: cents / 100, rate: effectiveRatePct(feeCents, cents), feeCents });
  };
  for (let cents = Math.max(1, fromCents); cents < 100; cents += 1) push(cents);
  for (let cents = 100; cents < 1_000; cents += 25) push(cents);
  for (let cents = 1_000; cents <= maxDollars * 100; cents += 100) push(cents);
  return points;
}

export interface SettlementPoint {
  id: string;
  tabId: string;
  label: string;
  dollars: number;
  rate: number;
  feeCents: number;
  chargedCents: number;
  naiveFeeCents: number;
  calls: number;
  createdAt: number;
}

export function settledTabs(settlements: readonly SettlementDTO[], tabs: ReadonlyMap<string, TabDTO>): SettlementPoint[] {
  return settlements
    .filter((s) => s.status === "completed" && s.chargedCents > 0)
    .map((s) => ({
      id: s.id,
      tabId: s.tabId,
      label: tabLabel(tabs.get(s.tabId), s.tabId),
      dollars: s.chargedCents / 100,
      rate: effectiveRatePct(s.paypalFeeCents, s.chargedCents),
      feeCents: s.paypalFeeCents,
      chargedCents: s.chargedCents,
      naiveFeeCents: s.naiveFeeCents,
      calls: s.callCount - s.voidCount,
      createdAt: s.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export interface FeeTotals {
  tabs: number;
  chargedCents: number;
  feeCents: number;
  naiveFeeCents: number;
  /** Effective rate across every settled tab, percent. */
  ratePct: number;
  savedCents: number;
}

export function feeTotals(points: readonly SettlementPoint[]): FeeTotals {
  const chargedCents = points.reduce((s, p) => s + p.chargedCents, 0);
  const feeCents = points.reduce((s, p) => s + p.feeCents, 0);
  const naiveFeeCents = points.reduce((s, p) => s + p.naiveFeeCents, 0);
  return {
    tabs: points.length,
    chargedCents,
    feeCents,
    naiveFeeCents,
    ratePct: effectiveRatePct(feeCents, chargedCents),
    savedCents: Math.max(0, naiveFeeCents - feeCents),
  };
}

/** "123×" style ratio of per-call fees to the batched fee. */
export function savingsMultiple(naiveCents: number, batchedCents: number): string | null {
  if (batchedCents <= 0 || naiveCents <= batchedCents) return null;
  const ratio = naiveCents / batchedCents;
  return `${ratio >= 10 ? Math.round(ratio).toLocaleString("en-US") : ratio.toFixed(1)}×`;
}
