/**
 * Policy editing helpers for the console: the editable draft (strings, so people can type freely),
 * conversion back to a Policy with field errors, and plain-English bullets for the current values.
 */
import { formatCents, formatUsd, type Micros, MICROS_PER_CENT, type Policy, policySchema } from "@p402/shared";
import { microsToInput, parseDollars, plural } from "../../lib/format";

export interface PolicyDraft {
  hold: string;
  closeAt: string;
  closeAfterDays: string;
  perCallMax: string;
  dailyCap: string;
  maxCallsPerMinute: string;
  smallTabMin: string;
  /** ["*"] for any listed seller, otherwise seller ids. */
  allowedSellers: string[];
  repeatRequestThreshold: string;
  repeatWindowSec: string;
  errorStreak: string;
  spendSpikeMultiplier: string;
  budgetWarnPct: string;
}

export type PolicyField = Exclude<keyof PolicyDraft, "allowedSellers"> | "allowedSellers";
export type PolicyErrors = Partial<Record<PolicyField, string>>;

export function draftFromPolicy(policy: Policy): PolicyDraft {
  return {
    hold: microsToInput(policy.holdCents * MICROS_PER_CENT),
    closeAt: microsToInput(policy.closeAtCents * MICROS_PER_CENT),
    closeAfterDays: String(policy.closeAfterDays),
    perCallMax: microsToInput(policy.perCallMaxMicros),
    dailyCap: microsToInput(policy.dailyCapMicros),
    maxCallsPerMinute: String(policy.maxCallsPerMinute),
    smallTabMin: microsToInput(policy.smallTabMinCents * MICROS_PER_CENT),
    allowedSellers: policy.allowedSellers.length ? [...policy.allowedSellers] : ["*"],
    repeatRequestThreshold: String(policy.alarms.repeatRequestThreshold),
    repeatWindowSec: String(policy.alarms.repeatWindowSec),
    errorStreak: String(policy.alarms.errorStreak),
    spendSpikeMultiplier: String(policy.alarms.spendSpikeMultiplier),
    budgetWarnPct: String(policy.alarms.budgetWarnPct),
  };
}

const INT = /^\d+$/;
const DECIMAL = /^\d+(\.\d+)?$/;

/** Turn the draft into a Policy, or explain what's wrong with each field. */
export function policyFromDraft(draft: PolicyDraft): { policy: Policy | null; errors: PolicyErrors } {
  const errors: PolicyErrors = {};

  const money = (field: PolicyField, value: string, opts: { wholeCents?: boolean; min?: Micros; max?: Micros; label?: string } = {}): Micros => {
    const micros = parseDollars(value);
    if (micros === null) {
      errors[field] = "Enter an amount, like 0.02";
      return 0;
    }
    if (opts.wholeCents && micros % MICROS_PER_CENT !== 0) errors[field] = "Whole cents only (PayPal amounts have two decimals)";
    else if (opts.min !== undefined && micros < opts.min) errors[field] = `At least ${formatUsd(opts.min)}`;
    else if (opts.max !== undefined && micros > opts.max) errors[field] = `At most ${formatUsd(opts.max)}`;
    return micros;
  };
  const int = (field: PolicyField, value: string, min: number, max: number): number => {
    const trimmed = value.trim();
    if (!INT.test(trimmed)) {
      errors[field] = "Enter a whole number";
      return 0;
    }
    const n = Number(trimmed);
    if (n < min || n > max) errors[field] = `Between ${min} and ${max.toLocaleString("en-US")}`;
    return n;
  };

  const holdMicros = money("hold", draft.hold, { wholeCents: true, min: 1_000_000, max: 10_000_000_000 });
  const closeAtMicros = money("closeAt", draft.closeAt, { wholeCents: true, min: 1_000_000, max: 10_000_000_000 });
  const perCallMaxMicros = money("perCallMax", draft.perCallMax, { min: 1, max: 100_000_000 });
  const dailyCapMicros = money("dailyCap", draft.dailyCap, { min: 1, max: 10_000_000_000 });
  const smallTabMinMicros = money("smallTabMin", draft.smallTabMin, { wholeCents: true, max: 10_000_000_000 });
  const closeAfterDays = int("closeAfterDays", draft.closeAfterDays, 1, 28);
  const maxCallsPerMinute = int("maxCallsPerMinute", draft.maxCallsPerMinute, 1, 100_000);
  const repeatRequestThreshold = int("repeatRequestThreshold", draft.repeatRequestThreshold, 2, 1_000);
  const repeatWindowSec = int("repeatWindowSec", draft.repeatWindowSec, 5, 3_600);
  const errorStreak = int("errorStreak", draft.errorStreak, 2, 1_000);
  const budgetWarnPct = int("budgetWarnPct", draft.budgetWarnPct, 10, 100);
  let spendSpikeMultiplier = 0;
  if (!DECIMAL.test(draft.spendSpikeMultiplier.trim())) errors.spendSpikeMultiplier = "Enter a number, like 4";
  else {
    spendSpikeMultiplier = Number(draft.spendSpikeMultiplier);
    if (spendSpikeMultiplier < 1.5 || spendSpikeMultiplier > 100) errors.spendSpikeMultiplier = "Between 1.5 and 100";
  }
  if (draft.allowedSellers.length === 0) errors.allowedSellers = "Pick at least one seller";

  // The gateway would quietly clamp these; say so instead.
  if (!errors.closeAt && !errors.hold && closeAtMicros > holdMicros) errors.closeAt = `Can't be more than the hold (${formatUsd(holdMicros)})`;
  if (!errors.dailyCap && !errors.hold && dailyCapMicros > holdMicros) errors.dailyCap = `Can't be more than the hold (${formatUsd(holdMicros)})`;
  if (!errors.perCallMax && !errors.dailyCap && perCallMaxMicros > dailyCapMicros) errors.perCallMax = "Can't be more than the daily cap";

  if (Object.keys(errors).length) return { policy: null, errors };

  const candidate: Policy = {
    holdCents: holdMicros / MICROS_PER_CENT,
    perCallMaxMicros,
    dailyCapMicros,
    allowedSellers: draft.allowedSellers,
    maxCallsPerMinute,
    closeAtCents: closeAtMicros / MICROS_PER_CENT,
    closeAfterDays,
    smallTabMinCents: smallTabMinMicros / MICROS_PER_CENT,
    alarms: { repeatRequestThreshold, repeatWindowSec, errorStreak, spendSpikeMultiplier, budgetWarnPct },
  };
  const parsed = policySchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[issue.path.length - 1] ?? "hold");
      const field = (FIELD_BY_POLICY_KEY[key] ?? "hold") as PolicyField;
      errors[field] ??= issue.message;
    }
    return { policy: null, errors };
  }
  return { policy: parsed.data, errors };
}

const FIELD_BY_POLICY_KEY: Record<string, PolicyField> = {
  holdCents: "hold",
  perCallMaxMicros: "perCallMax",
  dailyCapMicros: "dailyCap",
  allowedSellers: "allowedSellers",
  maxCallsPerMinute: "maxCallsPerMinute",
  closeAtCents: "closeAt",
  closeAfterDays: "closeAfterDays",
  smallTabMinCents: "smallTabMin",
  repeatRequestThreshold: "repeatRequestThreshold",
  repeatWindowSec: "repeatWindowSec",
  errorStreak: "errorStreak",
  spendSpikeMultiplier: "spendSpikeMultiplier",
  budgetWarnPct: "budgetWarnPct",
};

/** Plain-English bullets for a policy (used once the AI's own summary no longer matches the edits). */
export function describePolicy(policy: Policy, sellerNames: Record<string, string> = {}): string[] {
  const sellers = policy.allowedSellers.includes("*")
    ? "Any listed seller"
    : `Only ${policy.allowedSellers.map((id) => sellerNames[id] ?? id).join(", ")}`;
  const closeAt = policy.closeAtCents >= policy.holdCents ? "when spending reaches the hold" : `when spending reaches ${formatCents(policy.closeAtCents)}`;
  return [
    `Hold ${formatCents(policy.holdCents)} on PayPal; charge ${closeAt} or after ${plural(policy.closeAfterDays, "day")}.`,
    `No single call may cost more than ${formatUsd(policy.perCallMaxMicros)}.`,
    `Spend at most ${formatUsd(policy.dailyCapMicros)} a day.`,
    `${sellers}; at most ${plural(policy.maxCallsPerMinute, "call")} a minute.`,
    `Pause for an AI review if the same request repeats ${policy.alarms.repeatRequestThreshold} times in ${policy.alarms.repeatWindowSec} seconds, or after ${policy.alarms.errorStreak} voided calls in a row.`,
  ];
}

export const BUDGET_EXAMPLES = [
  "Up to $50 this week for product research. No call over 2 cents, $10 a day at most, any seller.",
  "$20 for price checks only. Max 1 cent per call, only pricewatch, 30 calls a minute.",
  "Give the shopping agent $100 for the week, $25 a day, and pause it if it repeats itself.",
] as const;
