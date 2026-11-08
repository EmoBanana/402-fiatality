/** Plain-English bullets for a policy, generated from the final numbers so they never disagree with them. */
import { type CatalogEntryDTO, formatCents, formatUsd, type Policy } from "@p402/shared";
import { listJoin, plural } from "../util/text";

export function summarizePolicy(policy: Policy, catalog: CatalogEntryDTO[] = []): string[] {
  const names = new Map(catalog.map((entry) => [entry.sellerId, entry.sellerName || entry.sellerId]));
  const bullets: string[] = [];

  const closeAt = policy.closeAtCents < policy.holdCents ? ` or once ${formatCents(policy.closeAtCents)} is spent` : "";
  bullets.push(
    `Holds ${formatCents(policy.holdCents)} on PayPal and charges once for what was used, after ${plural(policy.closeAfterDays, "day")}${closeAt}.`,
  );
  bullets.push(`Each API call may cost at most ${formatUsd(policy.perCallMaxMicros)}.`);
  if (policy.dailyCapMicros < policy.holdCents * 10_000) {
    bullets.push(`Spends at most ${formatUsd(policy.dailyCapMicros)} per day.`);
  }
  bullets.push(
    policy.allowedSellers.includes("*")
      ? "Agents may pay any listed seller."
      : `Agents may only pay ${listJoin(policy.allowedSellers.map((id) => names.get(id) ?? id))}.`,
  );
  const a = policy.alarms;
  bullets.push(
    `Pauses for an AI review if the same request repeats ${a.repeatRequestThreshold} times within ${a.repeatWindowSec} s, ` +
      `${a.errorStreak} calls fail in a row, or agents reach ${Math.ceil(policy.maxCallsPerMinute * 0.9)} calls a minute.`,
  );
  bullets.push(`Warns at ${a.budgetWarnPct}% of the hold; hard limit of ${policy.maxCallsPerMinute} calls a minute.`);
  return bullets.slice(0, 6);
}
