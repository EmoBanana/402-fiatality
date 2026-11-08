/**
 * Plain-English budget -> Policy (SPEC §7). The model answers in dollars (what people write) with nulls for
 * anything unmentioned; we convert units, fill gaps from the regex parser, repair cents/dollars slips, clamp
 * and normalizePolicy. Any model failure falls back to the regex parser.
 */
import type { LlmClient, LlmMessage } from "@p402/gateway/context";
import { type CatalogEntryDTO, DEFAULT_POLICY, dollarsToMicros, formatUsd, type PolicyParseDTO } from "@p402/shared";
import { z } from "zod";
import { draftToPolicy, LOOP_SENSITIVE_THRESHOLD, type PolicyDraft, resolveSellerIds, sellerRefs } from "./draft";
import { parsePolicyText } from "./regex";
import { summarizePolicy } from "./summary";

export const POLICY_TIMEOUT_MS = 40_000;

const modelPolicySchema = z.object({
  holdDollars: z.number().nullable(),
  perCallMaxDollars: z.number().nullable(),
  dailyCapDollars: z.number().nullable(),
  allowedSellers: z.array(z.string()),
  maxCallsPerMinute: z.number().int().nullable(),
  closeAfterDays: z.number().int().nullable(),
  pauseOnLoops: z.boolean(),
});

type ModelPolicy = z.infer<typeof modelPolicySchema>;

/** Offline (mock provider) and fallback path. */
export function parsePolicyWithRules(text: string, catalog: CatalogEntryDTO[], model: string, usedFallback: boolean): PolicyParseDTO {
  const policy = draftToPolicy(parsePolicyText(text, catalog));
  return { policy, summary: summarizePolicy(policy, catalog), model, usedFallback };
}

export async function parsePolicyWithLlm(llm: LlmClient, text: string, catalog: CatalogEntryDTO[]): Promise<PolicyParseDTO> {
  const fromRules = parsePolicyText(text, catalog);
  try {
    const reply = await llm.json(policyMessages(text, catalog), modelPolicySchema, {
      timeoutMs: POLICY_TIMEOUT_MS,
      maxTokens: 300,
      temperature: 0,
    });
    const policy = draftToPolicy(reconcile(fromModel(reply, catalog), fromRules));
    return { policy, summary: summarizePolicy(policy, catalog), model: llm.model, usedFallback: false };
  } catch {
    return parsePolicyWithRules(text, catalog, "regex", true);
  }
}

export function policyMessages(text: string, catalog: CatalogEntryDTO[]): LlmMessage[] {
  const d = DEFAULT_POLICY;
  const sellers = catalog.slice(0, 12).map((entry) => {
    const prices = entry.endpoints
      .slice(0, 4)
      .map((e) => `${e.method} ${e.path} ${formatUsd(e.priceMicros)}`)
      .join("; ");
    return `- ${entry.sellerId} (${entry.sellerName}): ${prices}`;
  });
  const exampleSeller = catalog[0]?.sellerId ?? "pricewatch";
  const system = [
    "Convert a company's plain-English budget for its AI agents into JSON spending limits.",
    "Money is in dollars (2 cents = 0.02). Use null for anything the text does not mention.",
    '- holdDollars: total budget for the tab ("spend up to $40 this week" -> 40)',
    '- perCallMaxDollars: most one API call may cost ("max 2 cents per call" -> 0.02)',
    '- dailyCapDollars: most the agents may spend per day ("$5 a day" -> 5)',
    "- allowedSellers: seller ids from the list below that the text allows; [] means any seller",
    "- maxCallsPerMinute: rate limit; closeAfterDays: tab length in days (1-28, a week = 7)",
    "- pauseOnLoops: true if the text asks to stop or pause loops or repeated calls",
    "Sellers:",
    ...(sellers.length > 0 ? sellers : ["- (no sellers listed yet; use the names in the text, lowercase)"]),
    `Defaults: hold ${formatUsd(d.holdCents * 10_000)}, per call ${formatUsd(d.perCallMaxMicros)}, daily ${formatUsd(d.dailyCapMicros)}, ` +
      `any seller, ${d.maxCallsPerMinute} calls a minute, ${d.closeAfterDays} days.`,
    "Reply with the JSON object only.",
  ].join("\n");
  const example: ModelPolicy = {
    holdDollars: 20,
    perCallMaxDollars: 0.005,
    dailyCapDollars: null,
    allowedSellers: [exampleSeller],
    maxCallsPerMinute: 30,
    closeAfterDays: null,
    pauseOnLoops: false,
  };
  return [
    { role: "system", content: system },
    { role: "user", content: `Up to $20 for a pricing study, half a cent per call at most, only ${exampleSeller}, 30 calls a minute.` },
    { role: "assistant", content: JSON.stringify(example) },
    { role: "user", content: text.slice(0, 2_000) },
  ];
}

function fromModel(reply: ModelPolicy, catalog: CatalogEntryDTO[]): PolicyDraft {
  const draft: PolicyDraft = {};
  const micros = (dollars: number | null) => (dollars !== null && dollars > 0 ? safeMicros(dollars) : undefined);
  const hold = micros(reply.holdDollars);
  if (hold !== undefined) draft.holdCents = Math.round(hold / 10_000);
  draft.perCallMaxMicros = micros(reply.perCallMaxDollars);
  draft.dailyCapMicros = micros(reply.dailyCapDollars);
  if (reply.maxCallsPerMinute !== null && reply.maxCallsPerMinute > 0) draft.maxCallsPerMinute = reply.maxCallsPerMinute;
  if (reply.closeAfterDays !== null && reply.closeAfterDays > 0) draft.closeAfterDays = reply.closeAfterDays;
  const sellers = resolveSellerIds(reply.allowedSellers, sellerRefs(catalog));
  if (sellers.length > 0) draft.allowedSellers = sellers;
  if (reply.pauseOnLoops) draft.alarms = { repeatRequestThreshold: LOOP_SENSITIVE_THRESHOLD };
  return withoutUndefined(draft);
}

/**
 * The model wins, except: fields it left out come from the regex parser, and money values that differ from
 * the regex's by a clean power of ten (a cents/dollars slip) take the regex value.
 */
export function reconcile(model: PolicyDraft, rules: PolicyDraft): PolicyDraft {
  const merged: PolicyDraft = { ...rules, ...model, alarms: { ...rules.alarms, ...model.alarms } };
  for (const key of ["holdCents", "perCallMaxMicros", "dailyCapMicros", "closeAtCents"] as const) {
    const a = model[key];
    const b = rules[key];
    if (a !== undefined && b !== undefined && isPowerOfTenApart(a, b)) merged[key] = b;
  }
  if (!model.allowedSellers?.length && rules.allowedSellers?.length) merged.allowedSellers = rules.allowedSellers;
  if (Object.keys(merged.alarms ?? {}).length === 0) delete merged.alarms;
  return merged;
}

function isPowerOfTenApart(a: number, b: number): boolean {
  if (a <= 0 || b <= 0) return false;
  const exp = Math.log10(Math.max(a, b) / Math.min(a, b));
  return exp >= 0.95 && Math.abs(exp - Math.round(exp)) < 0.02;
}

function safeMicros(dollars: number): number | undefined {
  try {
    return dollarsToMicros(dollars);
  } catch {
    return undefined;
  }
}

function withoutUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
