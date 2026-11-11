/**
 * The AI jury's docket, as plain data: every spend review (a rogue-agent case) and every PayPal dispute,
 * newest first, plus the labels each case shows. No React here, so the rules are unit-tested
 * (docket.test.ts).
 */
import type { AlarmKind, DisputeDTO, DisputeRecommendation, DisputeStatus, ReviewDTO, ReviewMessageDTO, TabDTO } from "@p402/shared";
import type { BadgeTone } from "../../components/Badge";
import { modelLabel } from "../../lib/format";

export type JuryCase =
  | { kind: "review"; id: string; at: number; review: ReviewDTO }
  | { kind: "dispute"; id: string; at: number; dispute: DisputeDTO };

export type CaseFilter = "all" | "rogue" | "disputes" | "open";

export const CASE_FILTERS: Array<{ value: CaseFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "rogue", label: "Rogue agents" },
  { value: "disputes", label: "Disputes" },
  { value: "open", label: "Open" },
];

export function parseFilter(value: string | null): CaseFilter {
  return CASE_FILTERS.some((f) => f.value === value) ? (value as CaseFilter) : "all";
}

/** Both kinds of case in one list, newest first (ties keep reviews before disputes, then id order). */
export function buildDocket(reviews: ReviewDTO[], disputes: DisputeDTO[]): JuryCase[] {
  const cases: JuryCase[] = [
    ...reviews.map((review) => ({ kind: "review" as const, id: review.id, at: review.createdAt, review })),
    ...disputes.map((dispute) => ({ kind: "dispute" as const, id: dispute.id, at: dispute.createdAt, dispute })),
  ];
  return cases.sort((a, b) => b.at - a.at || (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "review" ? -1 : 1));
}

/** Still waiting on someone: a hearing in progress, a review a human must decide, or an unresolved dispute. */
export function isOpenCase(c: JuryCase, tabs: ReadonlyMap<string, Pick<TabDTO, "status">>): boolean {
  if (c.kind === "dispute") return c.dispute.status !== "RESOLVED" || c.dispute.jury?.status === "running";
  const { review } = c;
  if (review.status === "running") return true;
  if (review.verdict && review.verdict !== "escalate") return false;
  // Escalated (or failed): open while the tab still waits paused for a human. A closed tab moots it.
  const tab = tabs.get(review.tabId);
  return !tab || tab.status === "paused";
}

export function matchesFilter(c: JuryCase, filter: CaseFilter, tabs: ReadonlyMap<string, Pick<TabDTO, "status">>): boolean {
  switch (filter) {
    case "rogue":
      return c.kind === "review";
    case "disputes":
      return c.kind === "dispute";
    case "open":
      return isOpenCase(c, tabs);
    default:
      return true;
  }
}

// ---------------------------------------------------------------- live updates

function sameMessage(a: ReviewMessageDTO, b: ReviewMessageDTO): boolean {
  return a.role === b.role && a.at === b.at && a.content === b.content;
}

/** Add a streamed message unless it's already there; keeps the record in the order spoken. */
export function withMessage(transcript: ReviewMessageDTO[], message: ReviewMessageDTO): ReviewMessageDTO[] {
  if (transcript.some((m) => sameMessage(m, message))) return transcript;
  return [...transcript, message].sort((a, b) => a.at - b.at);
}

/** Events race: never let a payload with fewer messages wipe out ones that already streamed in. */
function longer(previous: ReviewMessageDTO[] | undefined, next: ReviewMessageDTO[]): ReviewMessageDTO[] {
  return previous && previous.length > next.length ? previous : next;
}

export function upsertReview(list: ReviewDTO[] | undefined, review: ReviewDTO): ReviewDTO[] {
  const current = list ?? [];
  const index = current.findIndex((r) => r.id === review.id);
  if (index === -1) return [review, ...current];
  const next = current.slice();
  next[index] = { ...review, transcript: longer(current[index]!.transcript, review.transcript) };
  return next;
}

export function addReviewMessage(list: ReviewDTO[] | undefined, reviewId: string, message: ReviewMessageDTO): ReviewDTO[] | undefined {
  if (!list) return list;
  const index = list.findIndex((r) => r.id === reviewId);
  if (index === -1) return list;
  const next = list.slice();
  next[index] = { ...list[index]!, transcript: withMessage(list[index]!.transcript, message) };
  return next;
}

export function upsertDispute(list: DisputeDTO[] | undefined, dispute: DisputeDTO): DisputeDTO[] {
  const current = list ?? [];
  const index = current.findIndex((d) => d.id === dispute.id);
  if (index === -1) return [dispute, ...current];
  const previous = current[index]!;
  const next = current.slice();
  // A re-run starts a fresh jury (new createdAt): only keep streamed messages from the same hearing.
  const sameHearing = previous.jury && dispute.jury && previous.jury.createdAt === dispute.jury.createdAt;
  next[index] = {
    ...dispute,
    jury: dispute.jury && sameHearing ? { ...dispute.jury, transcript: longer(previous.jury!.transcript, dispute.jury.transcript) } : dispute.jury,
  };
  return next;
}

export function addDisputeMessage(list: DisputeDTO[] | undefined, disputeId: string, message: ReviewMessageDTO, at: number): DisputeDTO[] | undefined {
  if (!list) return list;
  const index = list.findIndex((d) => d.id === disputeId);
  if (index === -1) return list;
  const dispute = list[index]!;
  const jury = dispute.jury ?? { status: "running" as const, transcript: [], createdAt: at };
  const next = list.slice();
  next[index] = { ...dispute, jury: { ...jury, transcript: withMessage(jury.transcript, message) } };
  return next;
}

// ---------------------------------------------------------------- labels

type Spec = { label: string; tone: BadgeTone };

/** "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" -> "Merchandise or service not as described". */
export function sentenceCase(code: string): string {
  const words = code.trim().replace(/[_-]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

/** What a rogue-agent case came to, in the jury's words. */
export type ReviewOutcome = "frozen" | "voided" | "resumed" | "human" | "hearing";

export function reviewOutcome(review: Pick<ReviewDTO, "status" | "verdict">): ReviewOutcome {
  if (review.status === "running") return "hearing";
  switch (review.verdict) {
    case "freeze":
      return "frozen";
    case "void":
      return "voided";
    case "resume":
      return "resumed";
    default:
      return "human";
  }
}

export const REVIEW_OUTCOME: Record<ReviewOutcome, Spec> = {
  hearing: { label: "In session", tone: "accent" },
  frozen: { label: "Frozen", tone: "danger" },
  voided: { label: "Bad calls voided", tone: "accent" },
  resumed: { label: "Resumed", tone: "success" },
  human: { label: "Sent to a human", tone: "warning" },
};

export const FAULT_LABEL: Record<NonNullable<ReviewDTO["fault"]>, string> = {
  agent: "Agent at fault",
  seller: "Seller at fault",
  none: "No one at fault",
};

/** The alarm that called the jury, as a headline. */
export const ALARM_HEADLINE: Record<AlarmKind, string> = {
  repeat_request: "The agent repeated itself",
  error_streak: "Too many failed calls in a row",
  spend_spike: "Spending spiked",
  velocity: "Calls came too fast",
  budget_threshold: "Most of the hold was spent",
};

/** PayPal's dispute reason codes (Disputes API v1), in plain words. */
const DISPUTE_REASONS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Service not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorized payment",
  UNAUTHORIZED: "Unauthorized payment",
  CREDIT_NOT_PROCESSED: "Refund not processed",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid another way",
  CANCELED_RECURRING_BILLING: "Cancelled recurring billing",
  PROBLEM_WITH_REMITTANCE: "Problem with remittance",
  OTHER: "Other",
};

export function disputeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Dispute";
  return DISPUTE_REASONS[reason.toUpperCase()] ?? sentenceCase(reason);
}

const DISPUTE_STATUS: Record<DisputeStatus, Spec> = {
  OPEN: { label: "Open", tone: "warning" },
  WAITING_FOR_SELLER_RESPONSE: { label: "Awaiting response", tone: "warning" },
  WAITING_FOR_BUYER_RESPONSE: { label: "Waiting for the buyer", tone: "neutral" },
  UNDER_REVIEW: { label: "PayPal is reviewing", tone: "accent" },
  RESOLVED: { label: "Resolved", tone: "neutral" },
  OTHER: { label: "Open", tone: "neutral" },
};

const DISPUTE_OUTCOMES: Record<string, Spec> = {
  RESOLVED_SELLER_FAVOUR: { label: "Charge upheld", tone: "success" },
  RESOLVED_SELLER_FAVOR: { label: "Charge upheld", tone: "success" },
  RESOLVED_BUYER_FAVOUR: { label: "Refunded to the buyer", tone: "neutral" },
  RESOLVED_BUYER_FAVOR: { label: "Refunded to the buyer", tone: "neutral" },
  RESOLVED_WITH_PAYOUT: { label: "Resolved with a PayPal payout", tone: "neutral" },
  CANCELED_BY_BUYER: { label: "Withdrawn by the buyer", tone: "success" },
  CANCELLED_BY_BUYER: { label: "Withdrawn by the buyer", tone: "success" },
  ACCEPTED: { label: "Claim accepted", tone: "neutral" },
  DENIED: { label: "Claim denied", tone: "success" },
};

export function disputeOutcome(outcome: string | null | undefined): Spec | null {
  if (!outcome) return null;
  return DISPUTE_OUTCOMES[outcome.toUpperCase()] ?? { label: sentenceCase(outcome), tone: "neutral" };
}

/** The pill a dispute wears: its outcome once resolved, otherwise where it stands at PayPal. */
export function disputeBadge(dispute: Pick<DisputeDTO, "status" | "outcome">): Spec {
  if (dispute.status === "RESOLVED") return disputeOutcome(dispute.outcome) ?? DISPUTE_STATUS.RESOLVED;
  return DISPUTE_STATUS[dispute.status] ?? { label: sentenceCase(dispute.status), tone: "neutral" };
}

export function disputeStatusLabel(status: DisputeStatus | string): string {
  return DISPUTE_STATUS[status as DisputeStatus]?.label ?? sentenceCase(status);
}

const STAGES: Record<string, string> = {
  INQUIRY: "Inquiry",
  CHARGEBACK: "Chargeback",
  PRE_ARBITRATION: "Pre-arbitration",
  ARBITRATION: "Arbitration",
};

export function disputeStageLabel(stage: string | null | undefined): string | null {
  if (!stage) return null;
  return STAGES[stage.toUpperCase()] ?? sentenceCase(stage);
}

export const RECOMMENDATION: Record<DisputeRecommendation, { label: string; short: string }> = {
  contest: { label: "Contest the claim", short: "Contest" },
  partial_refund: { label: "Offer a partial refund", short: "Partial refund" },
  accept: { label: "Accept the claim", short: "Accept" },
};

export const ACTION_LABEL: Record<DisputeDTO["actions"][number]["kind"], string> = {
  send_evidence: "Evidence sent",
  make_offer: "Refund offered",
  accept_claim: "Claim accepted",
  escalate: "Escalated to a PayPal claim",
  sandbox_adjudicate: "PayPal ruling",
};

/** Who heard the case: "Gemma 4 · 12b", or "LLM mock" for the offline stand-in (as the header badge says). */
export function juryModelLabel(model: string | null | undefined): string {
  if (!model) return "The AI";
  return model === "mock" ? "Built-in rules" : modelLabel(model);
}

/** 0.92 -> 92 (null when unknown). */
export function confidencePct(confidence: number | null | undefined): number | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return Math.round(Math.min(1, Math.max(0, confidence)) * 100);
}
