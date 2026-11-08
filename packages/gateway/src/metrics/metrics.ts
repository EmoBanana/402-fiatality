/** Dashboard numbers: the metrics summary (also pushed over /ws) and per-bucket timeseries. */
import { MICROS_PER_CENT, naiveFeeCents, type MetricsSummaryDTO, type TimeseriesPointDTO } from "@p402/shared";
import type { AppContext } from "../context";
import { stmt } from "../db/db";

export const MAX_TIMESERIES_POINTS = 1_440;

export function metricsSummary(ctx: AppContext): MetricsSummaryDTO {
  const db = ctx.db;
  const v = stmt(
    db,
    `SELECT COALESCE(SUM(status = 'accepted'), 0) AS accepted,
            COALESCE(SUM(status = 'voided'), 0) AS voided,
            COALESCE(SUM(CASE WHEN status = 'accepted' THEN price_micros END), 0) AS billable,
            COALESCE(SUM(CASE WHEN status = 'voided' THEN price_micros END), 0) AS voided_micros
       FROM vouchers WHERE status != 'pending'`,
  ).get() as { accepted: number; voided: number; billable: number; voided_micros: number };
  const s = stmt(
    db,
    "SELECT COALESCE(SUM(charged_cents), 0) AS charged, COALESCE(SUM(paypal_fee_cents), 0) AS fee FROM settlements WHERE status = 'completed'",
  ).get() as { charged: number; fee: number };
  const paid = stmt(db, "SELECT COALESCE(SUM(paid_out_micros), 0) AS paid FROM seller_balances").get() as { paid: number };
  const counts = stmt(
    db,
    `SELECT (SELECT COUNT(*) FROM tabs WHERE status IN ('active', 'paused')) AS active_tabs,
            (SELECT COUNT(*) FROM alarms WHERE status IN ('open', 'reviewing')) AS open_alarms,
            (SELECT COUNT(*) FROM reviews) AS reviews`,
  ).get() as { active_tabs: number; open_alarms: number; reviews: number };
  return {
    calls: v.accepted + v.voided,
    accepted: v.accepted,
    voided: v.voided,
    billableMicros: v.billable,
    voidedMicros: v.voided_micros,
    settledMicros: s.charged * MICROS_PER_CENT,
    paypalFeeCents: s.fee,
    naiveFeeCents: naiveFeeCents(v.accepted, v.billable),
    sellersPaidMicros: paid.paid,
    activeTabs: counts.active_tabs,
    openAlarms: counts.open_alarms,
    reviews: counts.reviews,
  };
}

/**
 * Judged calls per `bucketSec` bucket over the last `minutes` (gateway clock), oldest first, empty buckets
 * included. Spend counts accepted calls only.
 */
export function timeseries(ctx: AppContext, minutes: number, bucketSec: number): TimeseriesPointDTO[] {
  const bucketMs = bucketSec * 1000;
  const count = Math.min(MAX_TIMESERIES_POINTS, Math.max(1, Math.ceil((minutes * 60_000) / bucketMs)));
  const firstStart = Math.floor(ctx.clock.now() / bucketMs) * bucketMs - (count - 1) * bucketMs;
  const points: TimeseriesPointDTO[] = Array.from({ length: count }, (_, i) => ({
    t: firstStart + i * bucketMs,
    calls: 0,
    voids: 0,
    spendMicros: 0,
    bySeller: {},
  }));
  const rows = stmt(
    ctx.db,
    `SELECT CAST((created_at - ?) / ? AS INTEGER) AS idx, seller_id,
            COUNT(*) AS calls,
            COALESCE(SUM(status = 'voided'), 0) AS voids,
            COALESCE(SUM(CASE WHEN status = 'accepted' THEN price_micros END), 0) AS spend
       FROM vouchers
      WHERE status != 'pending' AND created_at >= ? AND created_at < ?
      GROUP BY idx, seller_id`,
  ).all(firstStart, bucketMs, firstStart, firstStart + count * bucketMs) as Array<{
    idx: number;
    seller_id: string;
    calls: number;
    voids: number;
    spend: number;
  }>;
  for (const row of rows) {
    const point = points[row.idx];
    if (!point) continue;
    point.calls += row.calls;
    point.voids += row.voids;
    point.spendMicros += row.spend;
    point.bySeller[row.seller_id] = (point.bySeller[row.seller_id] ?? 0) + row.spend;
  }
  return points;
}
