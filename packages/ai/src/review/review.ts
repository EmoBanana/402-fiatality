/**
 * AI spend review (SPEC §5.4, §7): prosecutor -> defender -> judge, each message streamed through onMessage
 * as it finishes. Never throws: model errors, an invalid ruling, low confidence, cancellation and the 45 s
 * budget all end in "escalate" with a reason, and the judge's closing message says so.
 */
import type { LlmClient, SpendReviewInput, SpendReviewResult } from "@p402/gateway/context";
import type { ReviewMessageDTO, ReviewRole } from "@p402/shared";
import { clampWords, errorMessage, sleep } from "../util/text";
import { type Decision, decide, escalation, judgeSchema, rulingText } from "./decision";
import { ARGUMENT_WORDS, defenderTurn, judgeTurn, prosecutorTurn, reviewContext } from "./prompts";
import { ruleBasedReview } from "./rules";

export const REVIEW_BUDGET_MS = 45_000;
const MAX_MESSAGE_WORDS = 120;

export interface ReviewRunOptions {
  /** Total time for all three roles (default 45 s). */
  budgetMs?: number;
  /** Timestamps for messages (default Date.now). */
  now?: () => number;
  /** Mock provider only: pause between messages so a UI shows the debate arriving. */
  mockDelayMs?: number;
}

export async function runReview(
  llm: LlmClient,
  input: SpendReviewInput,
  onMessage: (message: ReviewMessageDTO) => void,
  signal: AbortSignal | undefined,
  opts: ReviewRunOptions = {},
): Promise<SpendReviewResult> {
  const now = opts.now ?? Date.now;
  const transcript: ReviewMessageDTO[] = [];
  const say = (role: ReviewRole, content: string) => {
    const message: ReviewMessageDTO = { role, content: clampWords(content, MAX_MESSAGE_WORDS), at: now() };
    transcript.push(message);
    try {
      onMessage(message);
    } catch {
      // A failing listener must not stop the review.
    }
  };
  const finish = (decision: Decision): SpendReviewResult => {
    say("judge", rulingText(decision));
    return { ...decision, transcript, model: llm.model };
  };

  const budgetMs = opts.budgetMs ?? REVIEW_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const combined = signal ? AbortSignal.any([budget, signal]) : budget;
  const stopped = (): Decision | null => {
    if (signal?.aborted) return escalation("The review was cancelled before the judge ruled.");
    if (budget.aborted) return escalation(`The review ran past its ${Math.round(budgetMs / 1000)} s budget; a human must decide.`);
    return null;
  };

  try {
    if (llm.provider === "mock") {
      const scripted = ruleBasedReview(input);
      for (const message of scripted.messages) {
        const halt = stopped();
        if (halt) return finish(halt);
        say(message.role, message.content);
        await sleep(opts.mockDelayMs ?? 0, combined);
      }
      return finish(stopped() ?? scripted.decision);
    }

    const context = reviewContext(input);
    const argue = { signal: combined, timeoutMs: budgetMs, maxTokens: 170, temperature: 0.3 };
    const prosecution = cleanArgument(await llm.chat([...context, prosecutorTurn()], argue));
    say("prosecutor", prosecution);
    const defense = cleanArgument(await llm.chat([...context, defenderTurn(prosecution)], argue));
    say("defender", defense);
    const ruling = await llm.json([...context, judgeTurn(prosecution, defense)], judgeSchema, {
      signal: combined,
      timeoutMs: budgetMs,
      maxTokens: 200,
      temperature: 0,
    });
    return finish(stopped() ?? decide(ruling, input.vouchers));
  } catch (err) {
    return finish(stopped() ?? escalation(`The AI review failed: ${errorMessage(err)}`));
  }
}

/** Drop role labels, markdown and stray tags the model may add; keep it within the word limit. */
export function cleanArgument(text: string): string {
  const cleaned = text
    .replace(/<\/?(?:evidence|prosecutor|defender)>/gi, "")
    .replace(/^\s*(?:#+\s*)?(?:\*\*)?(?:the\s+)?(?:prosecutor|defender|judge)(?:'s\s+argument)?\s*(?:\*\*\s*:|:\s*\*\*|:)\s*/i, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clampWords(cleaned || "(no argument given)", Math.max(ARGUMENT_WORDS, MAX_MESSAGE_WORDS));
}
