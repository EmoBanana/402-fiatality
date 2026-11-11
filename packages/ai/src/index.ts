// @p402/ai: Gemma 4 via Ollama (or any OpenAI-compatible server, or an offline mock) behind the
// LlmClient and AiService contracts in @p402/gateway/context.
export { createLlm, type CreateLlmOptions } from "./llm";
export { createMockLlm, MOCK_MODEL, type MockLlmOptions, type MockReply } from "./llm/mock";
export { createOllamaLlm, OLLAMA_NUM_CTX } from "./llm/ollama";
export { createOpenAiLlm } from "./llm/openai";
export { isLlmError, LlmError, type LlmErrorCode } from "./llm/errors";
export { parseJsonReply } from "./llm/json";
export { type AiServiceOptions, createAiService, warmUp } from "./service";
export { parsePolicyText } from "./policy/regex";
export { draftToPolicy, type PolicyDraft } from "./policy/draft";
export { summarizePolicy } from "./policy/summary";
export { REVIEW_BUDGET_MS } from "./review/review";
export { runDisputeJury } from "./dispute/jury";
export { ruleBasedJury } from "./dispute/rules";
export { ESCALATE_BELOW } from "./review/decision";
export { type GridSchemaSummary, summarizeGridSchema } from "./grid/schema";
