/** The jury judge's structured recommendation, validated against the dispute, and the closing message. */
import type { DisputeReviewInput } from "@p402/gateway/context";
import { formatCents, type DisputeRecommendation } from "@p402/shared";
import { z } from "zod";
import { normalizeConfidence } from "../review/decision";
import { clampWords, oneLine } from "../util/text";

export const JURY_REASON_WORDS = 25;
export const JURY_DRAFT_WORDS = 90;

export const juryJudgeSchema = z.object({
  recommendation: z.enum(["contest", "partial_refund", "accept"]),
  refundCents: z.number(),
  confidence: z.number(),
  reason: z.string().min(1).max(800),
  draft: z.string().max(3_000),
});

export type JuryJudgeOutput = z.infer<typeof juryJudgeSchema>;

export interface JuryDecision {
  recommendation: DisputeRecommendation;
  refundCents: number;
  confidence: number;
  reason: string;
  draft: string;
}

/**
 * Make the refund agree with the recommendation: contest refunds nothing, a partial refund is 1 cent up to
 * the disputed amount minus 1, accepting refunds the disputed amount unless a smaller refund was named.
 */
export function settleRefund(recommendation: DisputeRecommendation, refundCents: number, amountCents: number): { recommendation: DisputeRecommendation; refundCents: number } {
  const refund = Number.isFinite(refundCents) ? Math.round(refundCents) : 0;
  if (recommendation === "contest" || amountCents <= 0) return { recommendation: "contest", refundCents: 0 };
  if (recommendation === "partial_refund") {
    if (refund >= amountCents || amountCents === 1) return { recommendation: "accept", refundCents: amountCents };
    return { recommendation, refundCents: Math.min(amountCents - 1, Math.max(1, refund)) };
  }
  return { recommendation: "accept", refundCents: refund > 0 && refund < amountCents ? refund : amountCents };
}

export function decideJury(judge: JuryJudgeOutput, input: DisputeReviewInput, fallbackDraft: string): JuryDecision {
  const settled = settleRefund(judge.recommendation, judge.refundCents, input.amountCents);
  const draft = clampWords(oneLine(judge.draft), JURY_DRAFT_WORDS);
  return {
    ...settled,
    confidence: normalizeConfidence(judge.confidence),
    reason: clampWords(oneLine(judge.reason), JURY_REASON_WORDS),
    draft: draft || fallbackDraft,
  };
}

/** The judge's closing message in the transcript. */
export function juryRulingText(d: JuryDecision): string {
  const sure = `${Math.round(d.confidence * 100)}% confident`;
  switch (d.recommendation) {
    case "contest":
      return `Contest the dispute (${sure}). ${d.reason}`;
    case "partial_refund":
      return `Offer a ${formatCents(d.refundCents)} partial refund (${sure}). ${d.reason}`;
    default:
      return `Accept the claim and refund ${formatCents(d.refundCents)} (${sure}). ${d.reason}`;
  }
}
