/**
 * AiService (packages/gateway/src/context.ts) on top of one LlmClient. With the mock provider every feature
 * runs on deterministic rules, so the whole app works offline; with a real model each feature falls back to
 * the rules (policy, grid) or escalates (review) when the model fails.
 */
import type { AiService, LlmClient, LlmConfig } from "@p402/gateway/context";
import { chatProxy } from "./chat/proxy";
import { gridQuery } from "./grid/query";
import { createLlm } from "./llm";
import { parsePolicyWithLlm, parsePolicyWithRules } from "./policy/parse";
import { runReview } from "./review/review";

export interface AiServiceOptions {
  /** Use this client instead of createLlm(config). */
  llm?: LlmClient;
  /** Total time for one spend review before it escalates (default 45 s). */
  reviewBudgetMs?: number;
  /** Mock provider only: pause between review messages so the UI shows the debate streaming (default 0). */
  mockDelayMs?: number;
  /** Clock for review timestamps and relative grid filters ("last hour"); pass the gateway's demo clock. */
  now?: () => number;
}

/**
 * Load the model into memory ahead of the first real request (Ollama otherwise loads it on demand, which
 * can eat most of a review's 45 s budget). Resolves false instead of throwing; a no-op for the mock.
 */
export async function warmUp(llm: LlmClient, timeoutMs = 120_000): Promise<boolean> {
  if (llm.provider === "mock") return true;
  try {
    await llm.chat([{ role: "user", content: "Reply with OK." }], { maxTokens: 2, timeoutMs, temperature: 0 });
    return true;
  } catch {
    return false;
  }
}

export function createAiService(config: LlmConfig, opts: AiServiceOptions = {}): AiService {
  const llm = opts.llm ?? createLlm(config);
  const now = opts.now ?? Date.now;
  return {
    llm,
    async parsePolicy(text, catalog) {
      if (llm.provider === "mock") return parsePolicyWithRules(text, catalog, llm.model, false);
      return parsePolicyWithLlm(llm, text, catalog);
    },
    reviewSpend(input, onMessage, signal) {
      return runReview(llm, input, onMessage, signal, { budgetMs: opts.reviewBudgetMs, mockDelayMs: opts.mockDelayMs, now });
    },
    gridQuery(request) {
      return gridQuery(llm, request, now());
    },
    chatProxy(request, signal) {
      return chatProxy(llm, request, signal);
    },
  };
}
