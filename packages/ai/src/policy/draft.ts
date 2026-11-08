/** A partial policy as extracted from text, plus helpers to turn it into a valid Policy. */
import {
  type AlarmRules,
  type CatalogEntryDTO,
  DEFAULT_POLICY,
  normalizePolicy,
  type Policy,
  SELLER_ID_PATTERN,
  slugify,
} from "@p402/shared";

export interface PolicyDraft {
  holdCents?: number;
  perCallMaxMicros?: number;
  dailyCapMicros?: number;
  closeAtCents?: number;
  allowedSellers?: string[];
  maxCallsPerMinute?: number;
  closeAfterDays?: number;
  alarms?: Partial<AlarmRules>;
}

/** Loops are paused sooner when the text asks for it (default threshold is 5). */
export const LOOP_SENSITIVE_THRESHOLD = 3;

const LIMITS = {
  holdCents: [100, 1_000_000],
  perCallMaxMicros: [1, 100_000_000],
  dailyCapMicros: [1, 10_000_000_000],
  closeAtCents: [100, 1_000_000],
  maxCallsPerMinute: [1, 100_000],
  closeAfterDays: [1, 28],
} as const;

const ALARM_LIMITS: Record<keyof AlarmRules, readonly [number, number]> = {
  repeatRequestThreshold: [2, 1_000],
  repeatWindowSec: [5, 3_600],
  errorStreak: [2, 1_000],
  spendSpikeMultiplier: [1.5, 100],
  budgetWarnPct: [10, 100],
};

/** Infer a missing hold, clamp every field into policySchema's range, then normalizePolicy. Never throws. */
export function draftToPolicy(input: PolicyDraft): Policy {
  const draft = inferHold(input);
  const partial: Partial<Policy> = {};
  for (const key of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    const value = draft[key];
    if (typeof value === "number" && Number.isFinite(value)) partial[key] = clampInt(value, LIMITS[key]);
  }
  if (draft.alarms) {
    const alarms: AlarmRules = { ...DEFAULT_POLICY.alarms };
    for (const key of Object.keys(ALARM_LIMITS) as Array<keyof AlarmRules>) {
      const value = draft.alarms[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const [min, max] = ALARM_LIMITS[key];
      alarms[key] = key === "spendSpikeMultiplier" ? Math.min(max, Math.max(min, value)) : clampInt(value, [min, max]);
    }
    partial.alarms = alarms;
  }
  const sellers = [...new Set((draft.allowedSellers ?? []).filter((s) => s.length >= 1 && s.length <= 40))].slice(0, 100);
  if (sellers.length > 0) partial.allowedSellers = sellers;
  try {
    return normalizePolicy(partial);
  } catch {
    return normalizePolicy({});
  }
}

/** Without an explicit budget, size the hold from the daily cap over the tab's life. */
export function inferHold(draft: PolicyDraft): PolicyDraft {
  if (draft.holdCents !== undefined || draft.dailyCapMicros === undefined) return draft;
  const days = draft.closeAfterDays ?? DEFAULT_POLICY.closeAfterDays;
  return { ...draft, holdCents: Math.ceil((draft.dailyCapMicros * days) / 10_000) };
}

function clampInt(value: number, [min, max]: readonly [number, number]): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

// ---------------------------------------------------------------- seller name matching

export interface SellerRef {
  id: string;
  name: string;
  /** Lowercase spellings with spaces and punctuation removed ("pricewatch"). */
  keys: string[];
}

export function sellerRefs(catalog: CatalogEntryDTO[]): SellerRef[] {
  return catalog.map((entry) => ({
    id: entry.sellerId,
    name: entry.sellerName || entry.sellerId,
    keys: [...new Set([squash(entry.sellerId), squash(entry.sellerName ?? "")].filter((k) => k.length > 0))],
  }));
}

/** Catalog sellers mentioned in `text`, in order of first mention. */
export function findSellers(text: string, refs: SellerRef[]): string[] {
  const squashed = squash(text);
  const lower = text.toLowerCase();
  const hits: Array<{ id: string; at: number }> = [];
  for (const ref of refs) {
    let at = -1;
    for (const key of ref.keys) {
      const i = key.length >= 4 ? squashed.indexOf(key) : searchWord(lower, key);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at >= 0) hits.push({ id: ref.id, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id);
}

/** Map names or ids the model produced onto catalog ids; without a catalog keep valid slugs. */
export function resolveSellerIds(names: string[], refs: SellerRef[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name === "" || name === "*" || /^(any|all|every)\b/i.test(name)) continue;
    if (refs.length > 0) {
      const key = squash(name);
      const ref = refs.find((r) => r.keys.includes(key)) ?? refs.find((r) => r.keys.some((k) => k.length >= 4 && key.includes(k)));
      if (ref) out.push(ref.id);
    } else {
      const slug = slugify(name);
      if (SELLER_ID_PATTERN.test(slug)) out.push(slug);
    }
  }
  return [...new Set(out)];
}

export function squash(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function searchWord(lower: string, word: string): number {
  const match = new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).exec(lower);
  return match ? match.index : -1;
}
