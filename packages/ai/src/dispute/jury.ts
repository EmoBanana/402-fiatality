/**
 * The dispute jury (AiService.reviewDispute): prosecutor -> defender -> judge, each message streamed through
 * onMessage as it finishes. Never throws: model errors, an unusable ruling, cancellation and the review budget
 * end with `failed: true` and the ledger rules' recommendation, and the judge's closing message says so.
 */
import type { DisputeReviewInput, DisputeReviewResult, LlmClient } from "@p402/gateway/context";
import type { ReviewMessageDTO, ReviewRole } from "@p402/shared";
import { cleanArgument, REVIEW_BUDGET_MS } from "../review/review";
import { clampWords, errorMessage, sleep } from "../util/text";
import { decideJury, type JuryDecision, juryJudgeSchema, juryRulingText } from "./decision";
import { juryContext, juryDefenderTurn, juryJudgeTurn, juryProsecutorTurn } from "./prompts";
import { ruleBasedJury } from "./rules";

const MAX_MESSAGE_WORDS = 120;

export interface JuryRunOptions {
  /** Total time for all three roles (default 45 s, LLM_REVIEW_BUDGET_MS). */
  budgetMs?: number;
  now?: () => number;
  /** Mock provider only: pause between messages so a UI shows the hearing arriving. */
  mockDelayMs?: number;
}

export async function runDisputeJury(
  llm: LlmClient,
  input: DisputeReviewInput,
  onMessage: (message: ReviewMessageDTO) => void,
  signal: AbortSignal | undefined,
  opts: JuryRunOptions = {},
): Promise<DisputeReviewResult> {
  const now = opts.now ?? Date.now;
  const transcript: ReviewMessageDTO[] = [];
  const say = (role: ReviewRole, content: string) => {
    const message: ReviewMessageDTO = { role, content: clampWords(content, MAX_MESSAGE_WORDS), at: now() };
    transcript.push(message);
    try {
      onMessage(message);
    } catch {
      // A failing listener must not stop the hearing.
    }
  };
  const rules = ruleBasedJury(input);
  const finish = (decision: JuryDecision, failure?: string): DisputeReviewResult => {
    say("judge", failure ? `${failure} The ledger rules suggest: ${juryRulingText(decision)}` : juryRulingText(decision));
    return { ...decision, transcript, model: llm.model, ...(failure ? { failed: true, error: failure } : {}) };
  };

  const budgetMs = opts.budgetMs ?? REVIEW_BUDGET_MS;
  const budget = AbortSignal.timeout(budgetMs);
  const combined = signal ? AbortSignal.any([budget, signal]) : budget;
  const stopped = (): string | null => {
    if (signal?.aborted) return "The hearing was cancelled before the judge ruled.";
    if (budget.aborted) return `The hearing ran past its ${Math.round(budgetMs / 1000)} s budget.`;
    return null;
  };

  try {
    if (llm.provider === "mock") {
      for (const message of rules.messages) {
        const halt = stopped();
        if (halt) return finish(rules.decision, halt);
        say(message.role, message.content);
        await sleep(opts.mockDelayMs ?? 0, combined);
      }
      const halt = stopped();
      return halt ? finish(rules.decision, halt) : finish(rules.decision);
    }

    const context = juryContext(input);
    const argue = { signal: combined, timeoutMs: budgetMs, maxTokens: 80, temperature: 0.3 };
    const prosecution = cleanArgument(await llm.chat([...context, juryProsecutorTurn(input)], argue));
    say("prosecutor", prosecution);
    const defense = cleanArgument(await llm.chat([...context, juryDefenderTurn(prosecution)], argue));
    say("defender", defense);
    const ruling = await llm.json([...context, juryJudgeTurn(input, prosecution, defense)], juryJudgeSchema, {
      signal: combined,
      timeoutMs: budgetMs,
      maxTokens: 260,
      temperature: 0,
    });
    const halt = stopped();
    return halt ? finish(rules.decision, halt) : finish(decideJury(ruling, input, rules.decision.draft));
  } catch (err) {
    return finish(rules.decision, stopped() ?? `The model could not finish the hearing (${errorMessage(err)}).`);
  }
}
