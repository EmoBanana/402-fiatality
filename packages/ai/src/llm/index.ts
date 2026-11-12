import type { LlmClient, LlmConfig } from "@p402/gateway/context";
import type { FetchFn } from "./http";
import { createMockLlm } from "./mock";
import { createOllamaLlm } from "./ollama";
import { createOpenAiLlm } from "./openai";
import type { AiLlmClient } from "./types";

export interface CreateLlmOptions {
  /** Replace global fetch (tests). */
  fetch?: FetchFn;
  /** Ollama context window for every request (default 8192). */
  numCtx?: number;
  /** OpenAI-compatible servers: first pause before retrying a 5xx answer (default 500 ms; tests shorten it). */
  retryDelayMs?: number;
}

/** The configured LLM: Ollama (native API), any OpenAI-compatible server, or the offline mock. */
export function createLlm(config: LlmConfig, opts: CreateLlmOptions = {}): LlmClient & AiLlmClient {
  switch (config.provider) {
    case "ollama":
      return createOllamaLlm(config, opts);
    case "openai":
      return createOpenAiLlm(config, opts);
    case "mock":
      return createMockLlm();
    default:
      throw new Error(`Unknown LLM provider: ${String(config.provider)}`);
  }
}
