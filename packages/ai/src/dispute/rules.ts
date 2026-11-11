/**
 * Deterministic dispute jury for the offline mock (and the fallback when the model fails). Same three roles,
 * decided by ledger rules: a tab whose calls were mostly voided -> accept; a frozen runaway with repeated
 * calls -> refund those repeats as goodwill; otherwise contest, strongest when every billed call is signed by
 * the company's own enrolled keys. The buyer's message is quoted, never obeyed.
 */
import type { DisputeReviewInput } from "@p402/gateway/context";
import { formatCents, formatUsd, MICROS_PER_CENT, type ReviewRole } from "@p402/shared";
import { clean } from "../review/evidence";
import { clampWords, plural } from "../util/text";
import { JURY_REASON_WORDS, type JuryDecision, settleRefund } from "./decision";
import { allSigned, reasonText, signedText, voidShare } from "./facts";

/** At or above this share of voided calls the jury accepts the claim. */
export const MOSTLY_VOIDED = 0.5;

export interface ScriptedJury {
  messages: Array<{ role: ReviewRole; content: string }>;
  decision: JuryDecision;
}

export function ruleBasedJury(input: DisputeReviewInput): ScriptedJury {
  if (voidShare(input) >= MOSTLY_VOIDED) return mostlyVoided(input);
  if (input.frozenByReview && input.repeats.calls > 0) return runaway(input);
  return contest(input);
}

function buyerSays(input: DisputeReviewInput): string {
  return input.buyerMessage ? ` The buyer writes: “${clean(input.buyerMessage, 140)}”.` : "";
}

function defense(input: DisputeReviewInput): string {
  const sig = input.signatures;
  const sample = sig.samples[0];
  return (
    `${capitalize(signedText(input))} carries an Ed25519 signature from ${plural(sig.enrolledKeys, "agent key")} the company enrolled on its own tab` +
    `${sample ? `, e.g. ${sample.voucherId}` : ""}. ` +
    `${input.tab.voided > 0 ? `${voidedCalls(input)} never billed. ` : ""}` +
    `The ${formatCents(input.settlement.chargedCents)} charge is exactly the sum of those signed IOUs.`
  );
}

function mostlyVoided(input: DisputeReviewInput): ScriptedJury {
  const share = Math.round(voidShare(input) * 100);
  const settled = settleRefund("accept", input.amountCents, input.amountCents);
  return {
    messages: [
      {
        role: "prosecutor",
        content:
          `${share}% of this tab's calls failed (${input.tab.voided} of ${input.tab.calls} voided), so ${reasonText(input.reason)} rings true: the agent got little usable data.` +
          buyerSays(input),
      },
      {
        role: "defender",
        content: `${defense(input)} Still, with most calls failing, contesting would cost more goodwill than ${formatCents(input.amountCents)}.`,
      },
    ],
    decision: {
      ...settled,
      confidence: 0.8,
      reason: clampWords(`${share}% of the tab's calls failed and were voided; refunding the disputed ${formatCents(settled.refundCents)} is fair.`, JURY_REASON_WORDS),
      draft:
        `Most calls on this agent spending tab failed (${input.tab.voided} of ${input.tab.calls} were voided by our quality guard). ` +
        `We accept the claim and refund ${formatCents(settled.refundCents)}.`,
    },
  };
}

function runaway(input: DisputeReviewInput): ScriptedJury {
  const repeatCents = Math.max(1, Math.round(input.repeats.micros / MICROS_PER_CENT));
  const settled = settleRefund("partial_refund", repeatCents, input.amountCents);
  const target = input.repeats.sellerId ? ` to ${input.repeats.sellerId}` : "";
  return {
    messages: [
      {
        role: "prosecutor",
        content:
          `The agent repeated the same paid request${target} ${plural(input.repeats.calls, "time")} (${formatUsd(input.repeats.micros)}) until a spend review froze it. ` +
          `The buyer should not pay for a loop.${buyerSays(input)}`,
      },
      {
        role: "defender",
        content: `${defense(input)} The loop was the company's own agent, frozen by its own policy, but the repeats added no data.`,
      },
    ],
    decision: {
      ...settled,
      confidence: 0.78,
      reason: clampWords(
        `The company's own agent looped; refunding its ${plural(input.repeats.calls, "repeated call")} (${formatCents(settled.refundCents)}) is fair goodwill.`,
        JURY_REASON_WORDS,
      ),
      draft:
        `Every call on this tab was signed by the buyer's own enrolled agent keys. Its agent repeated identical requests until our AI spend review froze it; ` +
        `as goodwill we refund those ${plural(input.repeats.calls, "repeated call")}: ${formatCents(settled.refundCents)}.`,
    },
  };
}

function contest(input: DisputeReviewInput): ScriptedJury {
  const signed = allSigned(input);
  const unauthorised = input.reason === "UNAUTHORISED";
  const confidence = signed ? (unauthorised ? 0.9 : 0.8) : 0.62;
  const prosecutor = unauthorised
    ? `The buyer says nobody authorised this ${formatCents(input.amountCents)} charge for ${plural(input.settlement.callCount, "API call")} made by software, not a person.${buyerSays(input)}`
    : `The buyer says ${reasonText(input.reason)}: ${formatCents(input.amountCents)} for ${plural(input.settlement.callCount, "machine-made API call")} they may not recognise.${buyerSays(input)}`;
  const reason = signed
    ? unauthorised
      ? "Every billed call was signed by an agent key the company enrolled on its own tab; the charge was authorised."
      : "Every billed call is signed by the company's own agents and failed calls were never billed; the charge stands."
    : "Not every billed call verifies against the tab's enrolled keys; contest, but a human should check the ledger.";
  return {
    messages: [
      { role: "prosecutor", content: prosecutor },
      { role: "defender", content: defense(input) },
    ],
    decision: {
      recommendation: "contest",
      refundCents: 0,
      confidence,
      reason: clampWords(reason, JURY_REASON_WORDS),
      draft:
        `This ${formatCents(input.settlement.chargedCents)} charge is the sum of ${plural(input.settlement.callCount, "API call")} the buyer's own AI agents made on tab ${input.tab.id}. ` +
        `${capitalize(signedText(input))} carries an Ed25519 signature from an agent key enrolled with the buyer's enroll token. ` +
        `${input.tab.voided > 0 ? `${voidedCalls(input)} not billed. ` : ""}The signed per-call ledger is available on request.`,
    },
  };
}

/** "1 failed call was voided and" / "3 failed calls were voided and". */
function voidedCalls(input: DisputeReviewInput): string {
  return `${plural(input.tab.voided, "failed call")} ${input.tab.voided === 1 ? "was" : "were"} voided and`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
