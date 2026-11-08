/**
 * Runaway mode: the same search in a loop, ignoring the results, like an agent stuck retrying (SPEC §8.2).
 * The gateway's repeat_request alarm should pause the tab and the AI review should freeze it; the X402Error
 * that follows ends the run with a summary of what the gateway did. Bounded by `maxCalls`.
 */
import { formatUsd } from "@p402/shared";
import type { ModeOutcome, RunSession } from "../session";

export async function runRunaway(s: RunSession, maxCalls: number): Promise<ModeOutcome> {
  const { query, maxPriceCents } = s.task;
  s.thought(`Runaway mode: repeating the search for "${query}" without reading the results, like an agent stuck in a loop. PayPal 402 should catch it.`);
  for (let i = 1; i <= maxCalls; i++) {
    await s.perform("search", { query, maxPriceCents }, i === 1 ? `Search #1 for "${query}"` : `Search #${i} for "${query}" (same request again)`);
  }
  return {
    status: "finished",
    summary: `research ${formatUsd(s.state.spentMicros)} → no purchase: ${maxCalls} identical searches and no alarm stopped them (${s.callStats()}). Check the tab's repeat_request alarm.`,
  };
}
