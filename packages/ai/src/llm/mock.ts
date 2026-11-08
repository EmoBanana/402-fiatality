/**
 * Offline mock LLM: deterministic, no network. The AI service does not route its own features through it
 * (they use rule-based mocks); this client serves direct `llm.chat/json` callers such as the buyer agent.
 * `json()` returns scripted replies when given, otherwise a minimal instance of the requested schema.
 */
import type { LlmCallOptions, LlmHealth, LlmMessage } from "@p402/gateway/context";
import type { ChatRequestDTO, ChatResponseDTO } from "@p402/shared";
import type { z } from "zod";
import { oneLine, truncate } from "../util/text";
import { LlmError } from "./errors";
import { type Completion, structuredCall } from "./json";
import { sampleFromSchema } from "./schema";
import { type AiLlmClient, completionId, contentText } from "./types";

export const MOCK_MODEL = "mock";

export type MockReply = string | object | ((messages: LlmMessage[]) => string | object);

export interface MockLlmOptions {
  /** Reported as `llm.model` (default "mock"). */
  model?: string;
  /** Scripted replies consumed in order by chat() and json() (each json attempt takes one). */
  replies?: MockReply[];
}

export function createMockLlm(opts: MockLlmOptions = {}): AiLlmClient {
  const model = opts.model ?? MOCK_MODEL;
  const queue = [...(opts.replies ?? [])];

  function next(messages: LlmMessage[]): string | undefined {
    const reply = queue.shift();
    if (reply === undefined) return undefined;
    const value = typeof reply === "function" ? reply(messages) : reply;
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function guard(signal?: AbortSignal) {
    if (signal?.aborted) throw new LlmError("aborted", "Mock LLM request was cancelled");
  }

  return {
    provider: "mock",
    model,

    async chat(messages, callOpts: LlmCallOptions = {}) {
      guard(callOpts.signal);
      return next(messages) ?? mockAnswer(lastUserText(messages));
    },

    json<T>(messages: LlmMessage[], schema: z.ZodType<T>, callOpts: LlmCallOptions = {}): Promise<T> {
      return structuredCall(
        async (msgs, format): Promise<Completion> => {
          guard(callOpts.signal);
          return { content: next(msgs) ?? JSON.stringify(sampleFromSchema(format.schema)), truncated: false };
        },
        messages,
        schema,
        callOpts,
      );
    },

    async health(): Promise<LlmHealth> {
      return { reachable: true, model, detail: "Offline mock model (LLM_PROVIDER=mock)" };
    },

    async chatCompletion(request: ChatRequestDTO, callOpts = {}): Promise<ChatResponseDTO> {
      guard(callOpts.signal);
      const question = lastUserText(
        request.messages.map((m) => ({ role: m.role === "user" ? "user" : "system", content: contentText(m.content) })),
      );
      const answer = mockAnswer(question);
      const format = request.response_format;
      const content =
        format?.type === "json_schema"
          ? JSON.stringify(sampleFromSchema(format.json_schema.schema))
          : format?.type === "json_object"
            ? JSON.stringify({ answer })
            : answer;
      return {
        id: completionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  };
}

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && m.content.trim()) return m.content;
  }
  return "";
}

function mockAnswer(question: string): string {
  const q = truncate(oneLine(question), 120);
  return [
    `This is the offline mock model, so there is no language model behind this answer${q ? ` to "${q}"` : ""}.`,
    "The ledger, charts and AI review still work with deterministic rules.",
    "Set LLM_PROVIDER=ollama with gemma4:12b running for real answers.",
  ].join(" ");
}
