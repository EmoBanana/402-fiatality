/**
 * POST /api/ai/chat for the AG Studio adapter: OpenAI chat.completions in and out, non-streaming, always on
 * the configured model. Our clients translate tools and response_format natively; any other LlmClient gets
 * a plain-text conversation.
 */
import type { LlmClient, LlmMessage } from "@p402/gateway/context";
import type { ChatRequestDTO, ChatResponseDTO } from "@p402/shared";
import { completionId, contentText, supportsChatCompletion } from "../llm/types";

export async function chatProxy(llm: LlmClient, request: ChatRequestDTO, signal?: AbortSignal): Promise<ChatResponseDTO> {
  const body: ChatRequestDTO = { ...request, stream: false };
  if (supportsChatCompletion(llm)) return llm.chatCompletion(body, { signal });

  const messages: LlmMessage[] = body.messages
    .filter((m) => m.role !== "tool")
    .map((m): LlmMessage => ({ role: m.role === "tool" ? "user" : m.role, content: contentText(m.content) }))
    .filter((m) => m.content.trim() !== "");
  const content = await llm.chat(messages, { signal, temperature: body.temperature, maxTokens: body.max_tokens });
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: llm.model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}
