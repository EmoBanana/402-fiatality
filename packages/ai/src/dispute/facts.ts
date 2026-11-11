/**
 * Dispute jury input -> two blocks: facts the gateway computed from its own ledger (trusted), and the buyer's
 * message from PayPal (untrusted), fenced in <evidence> tags, flattened and stripped of angle brackets so
 * nothing inside can close the fence or pose as a new speaker.
 */
import type { DisputeReviewInput } from "@p402/gateway/context";
import { formatCents, formatUsd } from "@p402/shared";
import { clean } from "../review/evidence";
import { listJoin, plural } from "../util/text";

/** PayPal reason codes in words. */
export const REASON_TEXT: Record<string, string> = {
  UNAUTHORISED: "the buyer did not authorise the charge",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "the service was not as described",
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "the service was not received",
  DUPLICATE_TRANSACTION: "the buyer was charged twice",
  INCORRECT_AMOUNT: "the amount charged is wrong",
  CREDIT_NOT_PROCESSED: "a promised credit was not processed",
  CANCELED_RECURRING_BILLING: "the buyer had cancelled",
  PAYMENT_BY_OTHER_MEANS: "the buyer paid another way",
  PROBLEM_WITH_REMITTANCE: "a problem with the payment",
  OTHER: "another problem",
};

export function reasonText(reason: string): string {
  return REASON_TEXT[reason] ?? reason.toLowerCase().replace(/_/g, " ");
}

/** "every one of the 214 billed calls" / "212 of the 214 billed calls". */
export function signedText(input: DisputeReviewInput): string {
  const s = input.signatures;
  if (s.billedCalls === 0) return "no billed calls";
  return s.verified === s.billedCalls ? `every one of the ${plural(s.billedCalls, "billed call")}` : `${s.verified} of the ${plural(s.billedCalls, "billed call")}`;
}

export function allSigned(input: DisputeReviewInput): boolean {
  return input.signatures.billedCalls > 0 && input.signatures.verified === input.signatures.billedCalls;
}

/** Share of the tab's judged calls that the gateway voided (never billed). */
export function voidShare(input: DisputeReviewInput): number {
  return input.tab.calls > 0 ? input.tab.voided / input.tab.calls : 0;
}

export function buildDisputeFacts(input: DisputeReviewInput): string {
  const { settlement, tab, signatures: sig } = input;
  const company = input.companyName ? `${input.companyName}'s` : "the company's";
  const sellers = input.sellers.map((s) => `${s.sellerName ?? s.sellerId} ${plural(s.calls, "call")} ${formatUsd(s.grossMicros)}`);
  const voids = Object.entries(input.voidsByReason)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${reason} ${n}`);
  const lines = [
    `Dispute: PayPal reason ${input.reason} (${reasonText(input.reason)}), ${formatCents(input.amountCents)} of the ${formatCents(settlement.chargedCents)} charge, stage ${input.stage ?? "unknown"}, status ${input.status}.`,
    `The charge is one PayPal capture (${settlement.captureId ?? "no capture id"}) for ${plural(settlement.callCount, "billed API call")} that ${company} AI agents made on tab ${tab.id} (hold ${formatCents(tab.holdCents)}).`,
    sellers.length > 0 ? `Billed per seller: ${listJoin(sellers)}.` : "No seller was billed.",
    `Signatures: ${signedText(input)} carry a valid Ed25519 signature from ${plural(sig.enrolledKeys, "agent key")} enrolled on ${company} own tab with its enroll token (re-verified by the gateway). Samples: ${
      sig.samples.map((v) => `${v.voucherId} (request hash ${v.requestHash.slice(0, 12)}…)`).join(", ") || "none"
    }.`,
    tab.voided > 0
      ? `Voided and never billed: ${plural(tab.voided, "call")} worth ${formatUsd(tab.voidedMicros)} (${voids.join(", ")}), out of ${plural(tab.calls, "judged call")}.`
      : `No call on this tab was voided (${plural(tab.calls, "judged call")}).`,
  ];
  if (input.repeats.calls > 0) {
    lines.push(
      `Repeated requests: ${plural(input.repeats.calls, "billed call")} (${formatUsd(input.repeats.micros)}) repeated an identical earlier request${
        input.repeats.sellerId ? `, mostly to ${input.repeats.sellerId}` : ""
      }.`,
    );
  }
  if (input.reviews.length > 0) {
    const reviews = input.reviews.map((r) => `${r.alarmKind ?? "alarm"} -> ${r.verdict ?? "pending"}${r.fault ? ` (${r.fault} fault)` : ""}${r.decidedBy === "human" ? " by a human" : ""}`);
    lines.push(`AI spend reviews on the tab: ${reviews.join("; ")}.${input.frozenByReview ? " A review froze the company's own runaway agent." : ""}`);
  } else {
    lines.push("No spend alarm or AI review on the tab.");
  }
  return `Facts from the gateway's ledger (trusted):\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** The buyer's words, fenced. */
export function buildDisputeEvidence(input: DisputeReviewInput): string {
  const message = input.buyerMessage ? `"${clean(input.buyerMessage, 600)}"` : "(the buyer left no message)";
  return `<evidence>\nBuyer's message to PayPal: ${message}\n</evidence>`;
}
