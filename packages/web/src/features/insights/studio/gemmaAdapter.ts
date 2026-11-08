/**
 * AG Studio LLM adapter for Gemma, through the gateway's OpenAI-style proxy (POST /api/ai/chat).
 *
 * AG Studio owns the agent loop and its tools; the adapter runs one turn: it maps Studio's conversation
 * items to chat.completions messages, forwards the tool schemas, and replays the (non-streaming) reply as
 * Studio's text and tool-call events. A failed turn rejects `complete` once with a readable message (the
 * gateway unreachable, the route not wired yet, the model down) and leaves the stream empty.
 *
 * `useAiStatus()` exposes the last outcome so the page can say when the assistant is offline.
 */
import type { ChatMessageDTO, ChatRequestDTO, ChatResponseDTO, ChatToolCallDTO, ChatToolDTO } from "@p402/shared";
import type {
  AgAiConversationItem,
  AgAiEvent,
  AgAiOutputItem,
  AgLlmAdapter,
  AgLlmExecuteTurnOptions,
  AgLlmRequest,
  AgLlmResponse,
  AgLlmResponseHandler,
} from "ag-studio";
import { useSyncExternalStore } from "react";
import { api, ApiError } from "../../../lib/api";

// ---------------------------------------------------------------- status (for the page chrome)

export type AiStatus = { state: "idle" } | { state: "ok"; model: string } | { state: "offline"; message: string };

let status: AiStatus = { state: "idle" };
const listeners = new Set<() => void>();

function setStatus(next: AiStatus) {
  status = next;
  for (const listener of listeners) listener();
}

export function useAiStatus(): AiStatus {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => status,
    () => status,
  );
}

// ---------------------------------------------------------------- request mapping (Studio -> chat.completions)

function inputText(item: Extract<AgAiConversationItem, { kind: "input"; type: "message" }>): string {
  return item.content.map((part) => (part.type === "text" ? part.text : `[${part.type} omitted]`)).join("\n");
}

function outputText(item: Extract<AgAiConversationItem, { kind: "output"; type: "message" }>): string {
  return item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("");
}

export function toMessages(request: AgLlmRequest): ChatMessageDTO[] {
  const messages: ChatMessageDTO[] = [];
  if (request.instructions) messages.push({ role: "system", content: request.instructions });
  for (const item of request.input) {
    switch (item.type) {
      case "message":
        if (item.kind === "input") messages.push({ role: item.role, content: inputText(item) });
        else messages.push({ role: "assistant", content: outputText(item) });
        break;
      case "function_call": {
        const call: ChatToolCallDTO = { id: item.callId, type: "function", function: { name: item.name, arguments: item.arguments || "{}" } };
        const last = messages.at(-1);
        // Calls made in the same turn belong to one assistant message, followed by one tool message each.
        if (last?.role === "assistant") last.tool_calls = [...(last.tool_calls ?? []), call];
        else messages.push({ role: "assistant", content: null, tool_calls: [call] });
        break;
      }
      case "function_call_output":
        messages.push({ role: "tool", tool_call_id: item.callId, content: item.output });
        break;
      case "reasoning":
        break;
    }
  }
  return messages;
}

export function toChatRequest(request: AgLlmRequest): ChatRequestDTO {
  const tools: ChatToolDTO[] = (request.tools ?? [])
    .filter((tool) => tool.kind !== "provided")
    .map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
    }));
  const body: ChatRequestDTO = { messages: toMessages(request), stream: false, temperature: 0.2 };
  if (tools.length > 0) body.tools = tools;
  const choice = request.toolChoice;
  if (choice && tools.length > 0) body.tool_choice = typeof choice === "string" ? choice : { type: "function", function: { name: choice.name } };
  if (request.responseFormat?.type === "json") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: request.responseFormat.name, schema: request.responseFormat.schema as Record<string, unknown>, strict: false },
    };
  }
  return body;
}

// ---------------------------------------------------------------- response mapping (chat.completions -> Studio)

let sequence = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(sequence++).toString(36)}`;

export function toLlmResponse(res: ChatResponseDTO): AgLlmResponse {
  const choice = res.choices?.[0];
  const message = choice?.message;
  const output: AgAiOutputItem[] = [];
  const text = typeof message?.content === "string" ? message.content : "";
  if (text.trim()) {
    output.push({
      id: nextId("msg"),
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text, annotations: [] }],
    });
  }
  for (const call of message?.tool_calls ?? []) {
    if (!call?.function?.name) continue;
    const args = call.function.arguments as unknown;
    output.push({
      id: nextId("fc"),
      kind: "output",
      type: "function_call",
      callId: call.id || nextId("call"),
      name: call.function.name,
      // Some providers hand back an object; Studio expects the JSON text.
      arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      status: "completed",
    });
  }
  if (output.length === 0) {
    // An empty reply would leave the chat hanging; say so instead.
    output.push({
      id: nextId("msg"),
      kind: "output",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "text", text: "The model returned an empty reply. Try rephrasing the question.", annotations: [] }],
    });
  }
  return {
    id: res.id || nextId("resp"),
    createdAt: res.created ? res.created * 1000 : Date.now(),
    model: res.model,
    status: choice?.finish_reason === "length" ? "incomplete" : "completed",
    incompleteDetails: choice?.finish_reason === "length" ? { reason: "max_output_tokens" } : undefined,
    output,
    usage: res.usage
      ? { inputTokens: res.usage.prompt_tokens, outputTokens: res.usage.completion_tokens, totalTokens: res.usage.total_tokens }
      : undefined,
  };
}

function* replay(output: readonly AgAiOutputItem[]): Generator<AgAiEvent> {
  for (const item of output) {
    if (item.type === "message") {
      const text = item.content.map((part) => (part.type === "text" ? part.text : part.refusal)).join("");
      yield { type: "TEXT_MESSAGE_START", messageId: item.id, role: "assistant" };
      yield { type: "TEXT_MESSAGE_CONTENT", messageId: item.id, delta: text };
      yield { type: "TEXT_MESSAGE_END", messageId: item.id };
    } else if (item.type === "function_call") {
      yield { type: "TOOL_CALL_START", toolCallId: item.callId, toolCallName: item.name };
      yield { type: "TOOL_CALL_ARGS", toolCallId: item.callId, delta: item.arguments };
      yield { type: "TOOL_CALL_END", toolCallId: item.callId };
    }
  }
}

export function describeAiError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Can't reach the gateway, so Gemma is unavailable. Start it with `npm run dev`.";
    if (err.status === 503 && err.code === "not_wired") return "The AI assistant isn't connected yet: the gateway's /api/ai/chat route is not wired.";
    return err.message || `The AI request failed (${err.status}).`;
  }
  if (err instanceof DOMException && err.name === "AbortError") return "Cancelled.";
  return err instanceof Error ? err.message : "The AI request failed.";
}

// ---------------------------------------------------------------- the adapter

export const gemmaAdapter: AgLlmAdapter = {
  executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions): AgLlmResponseHandler {
    let resolve!: (response: AgLlmResponse) => void;
    let reject!: (error: Error) => void;
    const complete = new Promise<AgLlmResponse>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A consumer that stops reading the stream may never await `complete`; keep that rejection handled.
    void complete.catch(() => undefined);

    async function* run(): AsyncGenerator<AgAiEvent> {
      let response: AgLlmResponse;
      try {
        const res = await api.ai.chat(toChatRequest(request), options?.signal);
        response = toLlmResponse(res);
        setStatus({ state: "ok", model: res.model });
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === "AbortError";
        if (!aborted) setStatus({ state: "offline", message: describeAiError(err) });
        reject(new Error(describeAiError(err)));
        return;
      }
      yield* replay(response.output);
      resolve(response);
    }

    const stream = run();
    return { stream: { [Symbol.asyncIterator]: () => stream }, complete };
  },
};
