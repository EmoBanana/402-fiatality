/**
 * Deterministic spend review for the offline mock: same three roles, same decision rules, no model.
 * Loops and runaway pace -> freeze (agent fault); seller failures behind an error streak -> void exactly
 * those calls (seller fault); anything else -> resume. Excerpt text is never read as instructions.
 */
import type { SpendReviewInput } from "@p402/gateway/context";
import type { ReviewRole, VoidReason } from "@p402/shared";
import { clampWords, listJoin, plural, truncate } from "../util/text";
import { type Decision, REASON_MAX_WORDS } from "./decision";
import { analyzeVouchers, idList, type VoucherAnalysis } from "./evidence";

export interface ScriptedReview {
  messages: Array<{ role: ReviewRole; content: string }>;
  decision: Decision;
}

export function ruleBasedReview(input: SpendReviewInput): ScriptedReview {
  const a = analyzeVouchers(input.vouchers);
  switch (input.alarm.kind) {
    case "repeat_request":
    case "velocity":
    case "spend_spike":
      return agentFault(input, a);
    case "error_streak":
      return a.sellerFailures.length + a.suspicious.length > 0 ? sellerFault(input, a) : noFault(input, a);
    default:
      return noFault(input, a);
  }
}

function agentFault(input: SpendReviewInput, a: VoucherAnalysis): ScriptedReview {
  const rep = a.mostRepeated;
  const task = taskText(input);
  const confidence = input.alarm.kind === "repeat_request" ? 0.92 : input.alarm.kind === "velocity" ? 0.88 : 0.84;
  const accepted = a.vouchers.filter((v) => v.status === "accepted").length;
  const prosecutor = rep
    ? `The agent sent the same request to ${rep.sellerId} ${rep.count} times (${idList(rep.ids)}): ${quote(rep.label)}. ` +
      "A repeated paid call returns the same data, so every repeat after the first was wasted money. This is a loop, and the tab is paying for it."
    : `The agent made ${plural(a.vouchers.length, "call")} in ${a.spanSec} s across ${a.distinctRequests} requests. ` +
      `${input.alarm.message}. That pace is far beyond what one research task needs: this is runaway spending.`;
  const defender =
    `The sellers did their job: ${plural(accepted, "call")} returned valid data, so none of this is their fault. ` +
    `The task ${task} needed data, but ${rep ? "sending the identical request again cannot add anything new" : "no task needs this many calls this fast"}. ` +
    "I can defend the first calls, not the rest.";
  const reason = rep
    ? `Agent repeated ${quote(truncate(rep.label, 80))} ${rep.count} times; sellers delivered valid data and keep payment.`
    : `Agent spent at a runaway pace (${input.alarm.kind.replace("_", " ")}); sellers delivered valid data and keep payment.`;
  return script(prosecutor, defender, {
    verdict: "freeze",
    fault: "agent",
    confidence,
    reason: clampWords(reason, REASON_MAX_WORDS),
    voidVoucherIds: [],
  });
}

const FAILURE_WORDS: Partial<Record<VoidReason, string>> = {
  upstream_5xx: "server error",
  upstream_unreachable: "unreachable",
  timeout: "timed out",
  empty_result: "empty",
  malformed_json: "malformed JSON",
  schema_mismatch: "wrong schema",
};

function sellerFault(input: SpendReviewInput, a: VoucherAnalysis): ScriptedReview {
  const bad = [...a.sellerFailures, ...a.suspicious].sort((x, y) => x.createdAt - y.createdAt);
  const sellers = `Seller ${listJoin([...new Set(bad.map((v) => v.sellerId))])}`;
  const described = bad.map((v) => `${v.id} (${(v.voidReason && FAILURE_WORDS[v.voidReason]) ?? "junk response"})`);
  const list = described.length > 4 ? `${described.slice(0, 4).join(", ")} and ${described.length - 4} more` : listJoin(described);
  const prosecutor =
    `${sellers} returned ${plural(bad.length, "bad response")}: ${list}. ` +
    "Errors, empty bodies and malformed JSON are not data. The company should not pay for them.";
  const defender =
    `The agent's requests were well-formed${a.mostRepeated && a.mostRepeated.count >= 3 ? "" : " and distinct"}, so this is not a loop: ` +
    "the failures are on the seller's side. " +
    `The agent's task ${taskText(input)} is legitimate and its other calls returned useful data, so it should keep working.`;
  return script(prosecutor, defender, {
    verdict: "void",
    fault: "seller",
    confidence: 0.86,
    reason: clampWords(`${sellers} returned ${plural(bad.length, "failed or empty response")}; void only those calls and resume the agent.`, REASON_MAX_WORDS),
    voidVoucherIds: bad.map((v) => v.id),
  });
}

function noFault(input: SpendReviewInput, a: VoucherAnalysis): ScriptedReview {
  const prosecutor = `${input.alarm.message}. That pattern deserves a look before the agent spends more of the hold.`;
  const defender =
    `The last ${plural(a.vouchers.length, "call")} show no loop (${a.distinctRequests} distinct requests) and no seller failures. ` +
    `The spending fits the task ${taskText(input)}.`;
  return script(prosecutor, defender, {
    verdict: "resume",
    fault: "none",
    confidence: 0.72,
    reason: `No waste or bad data in the last ${plural(a.vouchers.length, "call")}; resuming the agent.`,
    voidVoucherIds: [],
  });
}

function script(prosecutor: string, defender: string, decision: Decision): ScriptedReview {
  return {
    messages: [
      { role: "prosecutor", content: prosecutor },
      { role: "defender", content: defender },
    ],
    decision,
  };
}

function taskText(input: SpendReviewInput): string {
  return input.task ? quote(truncate(input.task, 80)) : "(not recorded)";
}

function quote(text: string): string {
  return `“${text}”`;
}
