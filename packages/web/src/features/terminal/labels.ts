/** Labels and tones for terminal domain values (alarms, review verdicts and roles, payouts). */
import type { AlarmDTO, AlarmKind, ReviewDTO, ReviewRole, ReviewVerdict } from "@p402/shared";
import { type BadgeTone, PAYOUT_STATUS_BADGE, REVIEW_VERDICT_BADGE, SETTLEMENT_STATUS_BADGE } from "../../components";
import { VOID_REASON_LABELS } from "../../lib/format";

export const ALARM_KIND_LABELS: Record<AlarmKind, string> = {
  repeat_request: "Repeated request",
  error_streak: "Error streak",
  spend_spike: "Spend spike",
  velocity: "Velocity",
  budget_threshold: "Budget threshold",
};

export const ALARM_STATUS: Record<AlarmDTO["status"], { label: string; tone: BadgeTone }> = {
  open: { label: "Open", tone: "warning" },
  reviewing: { label: "Reviewing", tone: "accent" },
  resolved: { label: "Resolved", tone: "neutral" },
};

/** Review state shown on vouchers and alarms: the verdict, or "running" while the debate streams. */
export type ReviewState = ReviewVerdict | "running" | "failed";

/** Review-level outcome; verdict labels come from the shared REVIEW_VERDICT_BADGE so every page agrees. */
export const REVIEW_STATE: Record<ReviewState, { label: string; tone: BadgeTone }> = {
  running: { label: "Reviewing", tone: "accent" },
  failed: { label: "Review failed", tone: "danger" },
  ...REVIEW_VERDICT_BADGE,
};

export function reviewState(review: Pick<ReviewDTO, "status" | "verdict">): ReviewState {
  if (review.status === "running") return "running";
  if (review.status === "failed") return review.verdict ?? "failed";
  return review.verdict ?? "escalate";
}

/** What a review meant for one IOU it examined. */
export type RowReview = "reviewing" | "voided" | "reviewed" | "kept" | "frozen" | "escalated";

export const ROW_REVIEW: Record<RowReview, { label: string; tone: BadgeTone; hint: string }> = {
  reviewing: { label: "Reviewing", tone: "accent", hint: "An AI review is debating this spend right now" },
  voided: { label: "Voided", tone: "danger", hint: "The review voided this IOU as bad data, so it isn't billed" },
  reviewed: { label: "Reviewed", tone: "neutral", hint: "Already void under the seller's rules; the review read it as evidence" },
  kept: { label: "Kept", tone: "success", hint: "Reviewed and kept: the charge stands" },
  frozen: { label: "Agent frozen", tone: "danger", hint: "Needless spend: the review froze the agent; the seller keeps payment" },
  escalated: { label: "Escalated", tone: "warning", hint: "The judge wasn't sure, so a human decides" },
};

export function rowReview(review: ReviewDTO, voucher: { id: string; status: string }): RowReview {
  if (review.status === "running") return "reviewing";
  if (review.voidedVoucherIds.includes(voucher.id)) return "voided";
  if (voucher.status === "voided") return "reviewed";
  if (review.verdict === "freeze") return "frozen";
  if (review.verdict === "void" || review.verdict === "resume") return "kept";
  return "escalated";
}

export const ROLE_LABELS: Record<ReviewRole, string> = {
  prosecutor: "Prosecutor",
  defender: "Defender",
  judge: "Judge",
};

export const ROLE_ORDER: ReviewRole[] = ["prosecutor", "defender", "judge"];

export const FAULT_LABELS: Record<NonNullable<ReviewDTO["fault"]>, string> = {
  seller: "Seller at fault",
  agent: "Agent at fault",
  none: "No fault",
};

export const SETTLEMENT_STATUS = SETTLEMENT_STATUS_BADGE;

export const PAYOUT_STATUS = PAYOUT_STATUS_BADGE;

export function voidReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  return (VOID_REASON_LABELS as Record<string, string>)[reason] ?? reason.replace(/_/g, " ");
}

/** Micros as a number formatted for grids; aggregation results may arrive as {value} objects. */
export function numericValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value && typeof value === "object" && "value" in value) {
    const inner = (value as { value: unknown }).value;
    return typeof inner === "number" && Number.isFinite(inner) ? inner : null;
  }
  return null;
}
