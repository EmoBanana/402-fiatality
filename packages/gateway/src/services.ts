/**
 * Composition root: the real implementations behind AppContext, chosen from config.
 * src/index.ts builds the context with `createContext(config, createServices(config))`; tests skip this file
 * and pass fakes to createTestContext instead.
 */
import { runAgent } from "@p402/agent";
import { createAiService } from "@p402/ai";
import { demoSellers } from "@p402/sellers";
import type { AppConfig } from "./config";
import type { ContextOverrides } from "./context";
import { createPaypalClient } from "./paypal";
import { createSettlementService } from "./settlement";

/** Mock LLM only: pause between review messages so the offline demo shows the debate arriving. */
const MOCK_REVIEW_DELAY_MS = 700;

export function createServices(config: AppConfig): ContextOverrides {
  return {
    paypal: (ctx) => createPaypalClient(ctx),
    ai: (ctx) =>
      createAiService(config.llm, {
        reviewBudgetMs: config.reviewBudgetMs,
        now: () => ctx.clock.now(),
        mockDelayMs: config.llm.provider === "mock" && config.nodeEnv !== "test" ? MOCK_REVIEW_DELAY_MS : 0,
      }),
    settlement: (ctx) => createSettlementService(ctx),
    runAgent,
    demoSellers,
  };
}
