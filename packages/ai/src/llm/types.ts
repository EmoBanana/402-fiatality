import type { LlmClient } from "@p402/gateway/context";
import type { ChatMessageDTO, ChatRequestDTO, ChatResponseDTO } from "@p402/shared";

export interface ChatCompletionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Our clients also speak OpenAI chat.completions (tools, response_format) for the AG Studio proxy. */
export interface AiLlmClient extends LlmClient {
  chatCompletion(request: ChatRequestDTO, opts?: ChatCompletionOptions): Promise<ChatResponseDTO>;
}

export function supportsChatCompletion(llm: LlmClient): llm is AiLlmClient {
  return typeof (llm as Partial<AiLlmClient>).chatCompletion === "function";
}

/** Message text whether `content` is a string, null or OpenAI content parts. */
export function contentText(content: ChatMessageDTO["content"] | unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content.map((part) => (part as { text?: unknown } | null)?.text);
    return texts.filter((t): t is string => typeof t === "string" && t !== "").join("\n");
  }
  return "";
}

export function completionId(): string {
  return `chatcmpl-${globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const HEALTH_TIMEOUT_MS = 3_000;
export const CHAT_PROXY_TIMEOUT_MS = 120_000;
