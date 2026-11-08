import { z } from "zod";

export interface AlarmRules {
  /** Same request (same hash) this many times inside the window raises an alarm. */
  repeatRequestThreshold: number;
  repeatWindowSec: number;
  /** This many voided calls in a row raises an alarm. */
  errorStreak: number;
  /** Spend in the last minute above this multiple of the recent per-minute average. */
  spendSpikeMultiplier: number;
  /** Notify (no pause) when billable spend reaches this % of the hold. */
  budgetWarnPct: number;
}

/** A company's spending rules for one tab. Enforced by the gateway on every call. */
export interface Policy {
  /** Size of the PayPal hold placed when the tab opens. */
  holdCents: number;
  /** Most a single call may cost. */
  perCallMaxMicros: number;
  /** Most the tab may spend per calendar day (UTC). */
  dailyCapMicros: number;
  /** Seller ids this tab may pay, or ["*"] for any listed seller. */
  allowedSellers: string[];
  /** Hard rate limit across all sellers. */
  maxCallsPerMinute: number;
  /** Close (charge) the tab once billable spend reaches this. */
  closeAtCents: number;
  /** Normal tab length: hold on day 0, renew on day 4, charge by day 7. */
  closeAfterDays: number;
  /** Tabs below this on day 4 skip the early renewal and run up to day 28. */
  smallTabMinCents: number;
  alarms: AlarmRules;
}

export const DEFAULT_POLICY: Policy = {
  holdCents: 5_000,
  perCallMaxMicros: 50_000,
  dailyCapMicros: 25_000_000,
  allowedSellers: ["*"],
  maxCallsPerMinute: 120,
  closeAtCents: 5_000,
  closeAfterDays: 7,
  smallTabMinCents: 1_000,
  alarms: {
    repeatRequestThreshold: 5,
    repeatWindowSec: 60,
    errorStreak: 4,
    spendSpikeMultiplier: 4,
    budgetWarnPct: 85,
  },
};

export const alarmRulesSchema = z.object({
  repeatRequestThreshold: z.number().int().min(2).max(1_000),
  repeatWindowSec: z.number().int().min(5).max(3_600),
  errorStreak: z.number().int().min(2).max(1_000),
  spendSpikeMultiplier: z.number().min(1.5).max(100),
  budgetWarnPct: z.number().int().min(10).max(100),
});

export const policySchema = z.object({
  holdCents: z.number().int().min(100).max(1_000_000),
  perCallMaxMicros: z.number().int().min(1).max(100_000_000),
  dailyCapMicros: z.number().int().min(1).max(10_000_000_000),
  allowedSellers: z.array(z.string().min(1).max(40)).min(1).max(100),
  maxCallsPerMinute: z.number().int().min(1).max(100_000),
  closeAtCents: z.number().int().min(100).max(1_000_000),
  closeAfterDays: z.number().int().min(1).max(28),
  smallTabMinCents: z.number().int().min(0).max(1_000_000),
  alarms: alarmRulesSchema,
});

/** A policy with any field, and any alarm rule, left out. */
export type PolicyInput = Partial<Omit<Policy, "alarms">> & { alarms?: Partial<AlarmRules> };

/** Merge a partial policy over the defaults and keep fields consistent with each other. */
export function normalizePolicy(partial: PolicyInput = {}): Policy {
  const merged: Policy = {
    ...DEFAULT_POLICY,
    ...partial,
    alarms: { ...DEFAULT_POLICY.alarms, ...(partial.alarms ?? {}) },
    allowedSellers: partial.allowedSellers && partial.allowedSellers.length > 0 ? partial.allowedSellers : ["*"],
  };
  const holdMicros = merged.holdCents * 10_000;
  merged.closeAtCents = Math.min(merged.closeAtCents, merged.holdCents);
  merged.dailyCapMicros = Math.min(merged.dailyCapMicros, holdMicros);
  merged.perCallMaxMicros = Math.min(merged.perCallMaxMicros, merged.dailyCapMicros);
  return policySchema.parse(merged);
}

export function sellerAllowed(policy: Policy, sellerId: string): boolean {
  return policy.allowedSellers.includes("*") || policy.allowedSellers.includes(sellerId);
}
