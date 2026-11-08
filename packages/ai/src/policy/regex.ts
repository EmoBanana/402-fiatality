/**
 * Rule-based policy parser: the offline mock, and the fallback when the model is down or returns junk.
 * Handles budgets ("spend up to $40 this week"), per-call limits ("no more than 2 cents per call"), daily caps
 * ("$5 per day"), sellers ("only Channel3 and PriceWatch", "no reviews"), rates ("30 calls a minute") and
 * alarm wishes ("pause anything that loops", "stop after 3 errors in a row").
 */
import { type CatalogEntryDTO, SELLER_ID_PATTERN, slugify } from "@p402/shared";
import { findSellers, LOOP_SENSITIVE_THRESHOLD, type PolicyDraft, type SellerRef, sellerRefs } from "./draft";

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  fifty: 50,
  hundred: 100,
};
const WORD_NUMBER = Object.keys(WORD_NUMBERS).join("|");
/** Counts ("3 repeats", "five errors") never use "a"/"an". */
const COUNT_WORD = Object.keys(WORD_NUMBERS)
  .filter((w) => w !== "a" && w !== "an")
  .join("|");

const MONEY_RE = new RegExp(
  [
    String.raw`\$\s?(?<usd>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?<k>\s?k\b)?`,
    String.raw`(?<usdWords>\d+(?:\.\d+)?)\s*(?:usd|dollars?|bucks)\b`,
    String.raw`(?<cents>\d+(?:\.\d+)?|\.\d+)\s*(?:¢|c\b|cents?\b)`,
    String.raw`\b(?<halfCent>half\s+(?:a\s+)?(?:cent|penny))\b`,
    String.raw`\b(?<wordCents>${WORD_NUMBER})\s+(?:cents?|pennies|penny)\b`,
    String.raw`\b(?<wordUsd>${WORD_NUMBER})\s+(?:dollars?|bucks)\b`,
  ].join("|"),
  "gi",
);

type MoneyKind = "perCall" | "daily" | "close" | "week" | "month" | "hold";

const PER_CALL_AFTER = /^\s*(?:(?:per|a|an|each|every|\/)\s*(?:single\s+|api\s+|paid\s+)?(?:call|request|query|lookup|hit)s?\b|per[-\s]call\b)/;
const PER_CALL_BEFORE = /(?:per[-\s]?call|each\s+call|every\s+call|single\s+call|one\s+call|per[-\s]?request|each\s+request|any\s+call|a\s+call)\b[^$\d]{0,30}$/;
const DAILY_AFTER = /^\s*(?:(?:per|a|an|each|every|\/)\s*day\b|daily\b|per\s+24\s*h)/;
const DAILY_BEFORE = /(?:daily|per[-\s]?day|a\s+day|each\s+day|every\s+day)\s*(?:cap|limit|max(?:imum)?|budget|spend(?:ing)?|ceiling)?\s*(?:of|at|is|to|=|:)?\s*(?:up\s+to|at\s+most|no\s+more\s+than|max(?:imum)?)?\s*$/;
const CLOSE_BEFORE = /(?:close|charge|settle|bill|capture)\s+(?:the\s+tab\s+|it\s+)?(?:at|after|once\s+(?:it\s+)?(?:hits|reaches)|when\s+(?:it\s+)?(?:hits|reaches))\s*$/;
const WEEK_AFTER = /^\s*(?:(?:per|a|an|each|every|this|\/)\s*week\b|weekly\b)/;
const MONTH_AFTER = /^\s*(?:(?:per|a|an|each|every|this|\/)\s*month\b|monthly\b)/;

export function parsePolicyText(text: string, catalog: CatalogEntryDTO[] = []): PolicyDraft {
  const draft: PolicyDraft = {};
  const lower = text.toLowerCase();

  // Tab length first: "this week" / "for 3 days" also tells the hold apart from other amounts.
  const days = tabDays(lower);
  if (days !== undefined) draft.closeAfterDays = days;

  const holds: number[] = [];
  for (const mention of moneyMentions(text)) {
    switch (mention.kind) {
      case "perCall":
        draft.perCallMaxMicros ??= mention.micros;
        break;
      case "daily":
        draft.dailyCapMicros ??= mention.micros;
        break;
      case "close":
        draft.closeAtCents ??= Math.floor(mention.micros / 10_000);
        break;
      case "month":
        draft.closeAfterDays ??= 28;
        holds.push(mention.micros);
        break;
      default:
        holds.push(mention.micros);
    }
  }
  if (holds.length > 0) draft.holdCents = Math.round(Math.max(...holds) / 10_000);

  const sellers = parseSellers(text, catalog);
  if (sellers) draft.allowedSellers = sellers;

  const rate = /(\d+)\s*(?:paid\s+)?(?:calls?|requests?|queries|hits)\s*(?:(?:per|a|an|each|every|\/)\s*min(?:ute)?\b)/.exec(lower) ?? /(\d+)\s*rpm\b/.exec(lower);
  if (rate) draft.maxCallsPerMinute = Number(rate[1]);

  const alarms: PolicyDraft["alarms"] = {};
  const repeats = new RegExp(`\\b(\\d+|${COUNT_WORD})\\s+(?:repeats|repeated|identical|same)\\b`).exec(lower);
  if (repeats?.[1]) alarms.repeatRequestThreshold = toNumber(repeats[1]);
  else if (/\b(?:loop(?:s|ing|ed)?|repeat(?:s|ed|ing)?|runaway|stuck|spinning)\b/.test(lower)) {
    alarms.repeatRequestThreshold = LOOP_SENSITIVE_THRESHOLD;
  }
  const streak = new RegExp(`\\b(\\d+|${COUNT_WORD})\\s+(?:errors?|failures?|failed\\s+(?:calls?|requests?)|bad\\s+(?:calls?|responses?))`).exec(lower);
  if (streak?.[1]) alarms.errorStreak = toNumber(streak[1]);
  const warn = /(?:warn|alert|notify|tell)\s+(?:me\s+)?(?:at|when|once|if)?\s*(?:it\s+|we\s+)?(?:hits?|reach(?:es)?|pass(?:es)?)?\s*(\d{1,3})\s*%/.exec(lower);
  if (warn) alarms.budgetWarnPct = Number(warn[1]);
  if (Object.keys(alarms).length > 0) draft.alarms = alarms;

  return draft;
}

interface MoneyMention {
  micros: number;
  kind: MoneyKind;
}

function moneyMentions(text: string): MoneyMention[] {
  const lower = text.toLowerCase();
  const out: MoneyMention[] = [];
  for (const match of text.matchAll(MONEY_RE)) {
    const micros = toMicros(match.groups ?? {});
    if (micros === null || micros <= 0) continue;
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = lower.slice(Math.max(0, start - 48), start);
    const after = lower.slice(end, end + 40);
    out.push({ micros, kind: classify(before, after) });
  }
  return out;
}

function classify(before: string, after: string): MoneyKind {
  if (PER_CALL_AFTER.test(after) || PER_CALL_BEFORE.test(before)) return "perCall";
  if (DAILY_AFTER.test(after) || DAILY_BEFORE.test(before)) return "daily";
  if (CLOSE_BEFORE.test(before)) return "close";
  if (WEEK_AFTER.test(after)) return "week";
  if (MONTH_AFTER.test(after)) return "month";
  return "hold";
}

function toMicros(g: Record<string, string | undefined>): number | null {
  if (g.usd !== undefined) return dollars(Number(g.usd.replace(/,/g, "")) * (g.k ? 1_000 : 1));
  if (g.usdWords !== undefined) return dollars(Number(g.usdWords));
  if (g.cents !== undefined) return Math.round(Number(g.cents) * 10_000);
  if (g.halfCent !== undefined) return 5_000;
  if (g.wordCents !== undefined) return toNumber(g.wordCents) * 10_000;
  if (g.wordUsd !== undefined) return dollars(toNumber(g.wordUsd));
  return null;
}

function dollars(n: number): number | null {
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : null;
}

function toNumber(word: string): number {
  const n = Number(word);
  return Number.isFinite(n) ? n : (WORD_NUMBERS[word.toLowerCase()] ?? Number.NaN);
}

function tabDays(lower: string): number | undefined {
  const forDays = new RegExp(`\\bfor\\s+(?:the\\s+next\\s+)?(\\d+|${WORD_NUMBER})\\s+days?\\b`).exec(lower);
  if (forDays?.[1]) return toNumber(forDays[1]);
  const weeks = new RegExp(`\\b(\\d+|${WORD_NUMBER})\\s+weeks?\\b`).exec(lower);
  if (weeks?.[1]) return Math.min(28, toNumber(weeks[1]) * 7);
  if (/\b(?:this|per|a|each|one|the)\s+week\b|\bweekly\b/.test(lower)) return 7;
  if (/\b(?:this|per|a|each|one|the)\s+month\b|\bmonthly\b/.test(lower)) return 28;
  return undefined;
}

const ONLY_RE = /\b(?:only|just|exclusively|solely|stick\s+to|limit(?:ed)?\s+to|restrict(?:ed)?\s+to)\b([^.;\n]*)/gi;
const EXCLUDE_RE =
  /\b(?:not|no|never|avoid|except|excluding|exclude|without|skip|ban|block|don'?t\s+(?:use|pay|call)|do\s+not\s+(?:use|pay|call))\s+(?:the\s+|any\s+)?([^.;,\n]*)/gi;

/** Allowed seller ids, or undefined when the text doesn't restrict sellers. */
function parseSellers(text: string, catalog: CatalogEntryDTO[]): string[] | undefined {
  const refs = sellerRefs(catalog);
  const allowed: string[] = [];
  for (const match of text.matchAll(ONLY_RE)) {
    const clause = match[1] ?? "";
    allowed.push(...(refs.length > 0 ? findSellers(clause, refs) : slugList(clause)));
  }
  const excluded: string[] = [];
  if (refs.length > 0) {
    for (const match of text.matchAll(EXCLUDE_RE)) {
      const words = (match[1] ?? "").trim().split(/\s+/).slice(0, 4).join(" ");
      excluded.push(...findSellers(words, refs));
    }
  }
  if (allowed.length === 0 && excluded.length === 0) return undefined;
  const base = allowed.length > 0 ? [...new Set(allowed)] : refs.map((r) => r.id);
  const result = base.filter((id) => !excluded.includes(id));
  return result.length > 0 ? result : undefined;
}

/** Without a catalog: "only Channel3 and PriceWatch, pause ..." -> ["channel3", "pricewatch"]. */
function slugList(clause: string): string[] {
  const items = clause
    .replace(/^\s*(?:use|pay|call|buy\s+from|from|the|sellers?|apis?)\b/gi, "")
    .split(/,|\band\b|\bor\b|&|\+|\//i)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const item of items) {
    if (item.split(/\s+/).length > 2) break;
    const slug = slugify(item);
    if (!SELLER_ID_PATTERN.test(slug) || /^\d+$/.test(slug)) break;
    out.push(slug);
  }
  return out;
}

export type { SellerRef };
