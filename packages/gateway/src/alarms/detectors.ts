/**
 * Spend alarm detectors (SPEC §5.4), evaluated per tab after each judged voucher. Thresholds come from
 * `policy.alarms`. A pausing detector only counts calls made after the tab's previous pausing alarm, so the
 * evidence behind one review can't trigger the next one the moment the tab resumes.
 */
import { formatCents, formatUsd, MICROS_PER_CENT, type AlarmKind, type Policy } from "@p402/shared";
import { MINUTE_MS } from "../clock";
import type { Db } from "../db/db";
import { stmt } from "../db/db";
import type { TabRow } from "../db/dto";

export interface AlarmFinding {
  kind: AlarmKind;
  message: string;
  detail: Record<string, unknown>;
  /** Pausing alarms stop the tab and start an AI review; budget_threshold only notifies. */
  pause: boolean;
}

/** Minimum last-minute spend before a spike counts ($0.05). */
export const SPIKE_MIN_SPEND_MICROS = 50_000;
/** Minutes with calls the 10-minute baseline needs before spikes are judged. */
export const SPIKE_MIN_BASELINE_MINUTES = 3;
const BASELINE_MINUTES = 10;

export const PAUSING_KINDS: AlarmKind[] = ["repeat_request", "error_streak", "velocity", "spend_spike"];

/** When the tab's latest pausing alarm was raised (0 if never). */
export function lastPausingAlarmAt(db: Db, tabId: string): number {
  const row = stmt(
    db,
    `SELECT MAX(created_at) AS at FROM alarms WHERE tab_id = ? AND kind IN ('repeat_request', 'error_streak', 'velocity', 'spend_spike')`,
  ).get(tabId) as { at: number | null };
  return row.at ?? 0;
}

export function detectRepeatRequest(db: Db, tabId: string, policy: Policy, now: number, since: number, reqHash: string): AlarmFinding | null {
  const { repeatRequestThreshold: threshold, repeatWindowSec } = policy.alarms;
  const from = Math.max(now - repeatWindowSec * 1000, since);
  const row = stmt(db, "SELECT COUNT(*) AS n, MIN(path) AS path FROM vouchers WHERE tab_id = ? AND req_hash = ? AND created_at > ?").get(
    tabId,
    reqHash,
    from,
  ) as { n: number; path: string | null };
  if (row.n < threshold) return null;
  return {
    kind: "repeat_request",
    message: `The same request was paid for ${row.n} times in ${repeatWindowSec} s (${row.path ?? "unknown path"}).`,
    detail: { reqHash, count: row.n, threshold, windowSec: repeatWindowSec, path: row.path },
    pause: true,
  };
}

export function detectErrorStreak(db: Db, tabId: string, policy: Policy, since: number): AlarmFinding | null {
  const n = policy.alarms.errorStreak;
  const rows = stmt(
    db,
    `SELECT status, void_reason FROM vouchers WHERE tab_id = ? AND status != 'pending' AND created_at > ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  ).all(tabId, since, n) as Array<{ status: string; void_reason: string | null }>;
  if (rows.length < n || rows.some((r) => r.status !== "voided")) return null;
  const reasons = [...new Set(rows.map((r) => r.void_reason ?? "unknown"))];
  return {
    kind: "error_streak",
    message: `The last ${n} calls were all voided (${reasons.join(", ")}).`,
    detail: { streak: n, reasons },
    pause: true,
  };
}

export function velocityThreshold(policy: Policy): number {
  return Math.max(2, Math.ceil(policy.maxCallsPerMinute * 0.9));
}

export function detectVelocity(db: Db, tabId: string, policy: Policy, now: number, since: number): AlarmFinding | null {
  const threshold = velocityThreshold(policy);
  const row = stmt(db, "SELECT COUNT(*) AS n FROM vouchers WHERE tab_id = ? AND created_at > ?").get(tabId, Math.max(now - MINUTE_MS, since)) as {
    n: number;
  };
  if (row.n < threshold) return null;
  return {
    kind: "velocity",
    message: `${row.n} calls in the last minute, close to the limit of ${policy.maxCallsPerMinute}.`,
    detail: { calls: row.n, threshold, maxCallsPerMinute: policy.maxCallsPerMinute },
    pause: true,
  };
}

/**
 * Last-minute spend above `spendSpikeMultiplier` x the average spend per active minute over the 10 minutes
 * before it. Needs >= 3 minutes with calls in that baseline and >= $0.05 spent in the last minute.
 */
export function detectSpendSpike(db: Db, tabId: string, policy: Policy, now: number, since: number): AlarmFinding | null {
  const recent = stmt(
    db,
    "SELECT COALESCE(SUM(price_micros), 0) AS spend FROM vouchers WHERE tab_id = ? AND status != 'voided' AND created_at > ?",
  ).get(tabId, Math.max(now - MINUTE_MS, since)) as { spend: number };
  if (recent.spend < SPIKE_MIN_SPEND_MICROS) return null;
  const baselineStart = now - (BASELINE_MINUTES + 1) * MINUTE_MS;
  const buckets = stmt(
    db,
    `SELECT CAST((created_at - ?) / ? AS INTEGER) AS minute, COALESCE(SUM(CASE WHEN status != 'voided' THEN price_micros END), 0) AS spend
       FROM vouchers WHERE tab_id = ? AND created_at > ? AND created_at <= ?
      GROUP BY minute`,
  ).all(baselineStart, MINUTE_MS, tabId, baselineStart, now - MINUTE_MS) as Array<{ minute: number; spend: number }>;
  if (buckets.length < SPIKE_MIN_BASELINE_MINUTES) return null;
  const average = buckets.reduce((sum, b) => sum + b.spend, 0) / buckets.length;
  const multiplier = policy.alarms.spendSpikeMultiplier;
  if (recent.spend <= multiplier * average) return null;
  return {
    kind: "spend_spike",
    message: `Spent ${formatUsd(recent.spend)} in the last minute, over ${multiplier}x the recent average of ${formatUsd(Math.round(average))}.`,
    detail: { lastMinuteMicros: recent.spend, averageMicros: Math.round(average), multiplier, baselineMinutes: buckets.length },
    pause: true,
  };
}

/** First pausing finding, in priority order. */
export function detectPausing(db: Db, tab: Pick<TabRow, "id">, policy: Policy, now: number, reqHash: string | null): AlarmFinding | null {
  const since = lastPausingAlarmAt(db, tab.id);
  return (
    (reqHash ? detectRepeatRequest(db, tab.id, policy, now, since, reqHash) : null) ??
    detectErrorStreak(db, tab.id, policy, since) ??
    detectVelocity(db, tab.id, policy, now, since) ??
    detectSpendSpike(db, tab.id, policy, now, since)
  );
}

/** Notify-only, once per tab: billable spend reached `budgetWarnPct` of the hold. */
export function detectBudgetThreshold(db: Db, tab: Pick<TabRow, "id" | "hold_cents" | "carry_in_micros">, policy: Policy): AlarmFinding | null {
  const already = stmt(db, "SELECT 1 FROM alarms WHERE tab_id = ? AND kind = 'budget_threshold' LIMIT 1").get(tab.id);
  if (already) return null;
  const row = stmt(db, "SELECT COALESCE(SUM(price_micros), 0) AS billable FROM vouchers WHERE tab_id = ? AND status = 'accepted'").get(tab.id) as {
    billable: number;
  };
  const billable = row.billable + tab.carry_in_micros;
  const holdMicros = tab.hold_cents * MICROS_PER_CENT;
  const pct = policy.alarms.budgetWarnPct;
  if (holdMicros <= 0 || billable * 100 < holdMicros * pct) return null;
  return {
    kind: "budget_threshold",
    message: `Billable spend reached ${Math.floor((billable * 100) / holdMicros)}% of the ${formatCents(tab.hold_cents)} hold.`,
    detail: { billableMicros: billable, holdCents: tab.hold_cents, budgetWarnPct: pct },
    pause: false,
  };
}
