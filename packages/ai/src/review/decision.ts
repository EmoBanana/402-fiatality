/** The judge's structured ruling, its validation against the review input, and the escalation rules. */
import type { SpendReviewVoucher } from "@p402/gateway/context";
import type { ReviewFault, ReviewVerdict } from "@p402/shared";
import { z } from "zod";
import { clampWords, oneLine, plural } from "../util/text";
import { idList } from "./evidence";

/** Below this confidence the review escalates to a human. */
export const ESCALATE_BELOW = 0.6;
export const REASON_MAX_WORDS = 25;

export const judgeSchema = z.object({
  verdict: z.enum(["resume", "void", "freeze"]),
  fault: z.enum(["seller", "agent", "none"]),
  confidence: z.number(),
  reason: z.string().min(1).max(600),
  voidVoucherIds: z.array(z.string()).max(50),
});

export type JudgeOutput = z.infer<typeof judgeSchema>;

export interface Decision {
  verdict: ReviewVerdict;
  fault: ReviewFault;
  confidence: number;
  reason: string;
  voidVoucherIds: string[];
}

/**
 * Validate the ruling against the input: ids must be input voucher ids, verdict and fault must agree
 * (void = seller, freeze = agent, resume = none or seller with the bad calls already voided), and
 * confidence must reach 0.6. Anything else escalates, keeping the judge's suggestion for the human.
 */
export function decide(judge: JudgeOutput, vouchers: SpendReviewVoucher[]): Decision {
  const confidence = normalizeConfidence(judge.confidence);
  const reason = clampWords(oneLine(judge.reason), REASON_MAX_WORDS);
  const ids = resolveVoucherIds(judge.voidVoucherIds, vouchers);
  const fault: ReviewFault = judge.verdict === "freeze" ? "agent" : judge.verdict === "void" ? "seller" : judge.fault;
  const suggestion = { fault, confidence, voidVoucherIds: judge.verdict === "void" ? ids : [] };

  if (judge.verdict === "void" && ids.length === 0) {
    return escalation(`The judge chose to void calls but named none from this review. ${reason}`, suggestion);
  }
  const inconsistent =
    (judge.verdict === "void" && judge.fault === "agent") ||
    (judge.verdict === "freeze" && judge.fault === "seller") ||
    (judge.verdict === "resume" && judge.fault === "agent");
  if (inconsistent) {
    return escalation(`The ruling contradicts itself (${judge.verdict} with ${judge.fault} fault). ${reason}`, suggestion);
  }
  if (confidence < ESCALATE_BELOW) {
    return escalation(`Confidence ${pct(confidence)} is below ${pct(ESCALATE_BELOW)}; suggested ${judge.verdict}. ${reason}`, suggestion);
  }
  return { verdict: judge.verdict, reason, ...suggestion };
}

export function escalation(reason: string, suggestion: Partial<Omit<Decision, "verdict" | "reason">> = {}): Decision {
  return {
    verdict: "escalate",
    fault: suggestion.fault ?? "none",
    confidence: suggestion.confidence ?? 0,
    reason: clampWords(oneLine(reason), 60),
    voidVoucherIds: suggestion.voidVoucherIds ?? [],
  };
}

/** The judge's closing message in the transcript. */
export function rulingText(d: Decision): string {
  const sure = `${pct(d.confidence)} confident`;
  switch (d.verdict) {
    case "freeze":
      return `Freeze the agent (agent fault, ${sure}). ${d.reason}`;
    case "void":
      return `Void ${plural(d.voidVoucherIds.length, "call")}: ${idList(d.voidVoucherIds, 6)} (seller fault, ${sure}). ${d.reason}`;
    case "resume":
      return `Resume the agent (${d.fault === "seller" ? "seller fault, bad calls already voided" : "no fault"}, ${sure}). ${d.reason}`;
    default:
      return `Escalate to a human. ${d.reason}`;
  }
}

/**
 * Map what the judge wrote to input voucher ids: exact ids, "#3" positions in the evidence, or an
 * unambiguous id suffix of 6+ characters. Unknown references are dropped.
 */
export function resolveVoucherIds(refs: string[], vouchers: SpendReviewVoucher[]): string[] {
  const known = new Set(vouchers.map((v) => v.id));
  const out: string[] = [];
  for (const raw of refs) {
    const ref = raw.trim().replace(/^\[|\]$/g, "");
    let id: string | undefined;
    if (known.has(ref)) id = ref;
    else if (/^#\d+$/.test(ref)) id = vouchers[Number(ref.slice(1)) - 1]?.id;
    else if (ref.length >= 6) {
      const matches = vouchers.filter((v) => v.id.endsWith(ref));
      if (matches.length === 1) id = matches[0]?.id;
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const v = value > 1 && value <= 100 ? value / 100 : value;
  return Math.round(Math.min(1, Math.max(0, v)) * 100) / 100;
}

function pct(c: number): string {
  return `${Math.round(c * 100)}%`;
}
