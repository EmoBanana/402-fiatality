/**
 * Ollama provider over the native API: POST /api/chat (non-streaming, structured outputs via `format`,
 * thinking off) and GET /api/tags for health. Every call sends the same `num_ctx` so Ollama never reloads
 * the model between our requests, and `keep_alive` keeps it warm for the demo.
 */
import type { LlmCallOptions, LlmConfig, LlmHealth, LlmMessage } from "@p402/gateway/context";
import type { ChatRequestDTO, ChatResponseDTO, ChatToolCallDTO } from "@p402/shared";
import type { z } from "zod";
import { LlmError } from "./errors";
import { type FetchFn, type HttpResult, httpJson, serverError } from "./http";
import { type Completion, type StructuredFormat, structuredCall } from "./json";
import { closeObjects, forGrammar, isRecord } from "./schema";
import {
  type AiLlmClient,
  CHAT_PROXY_TIMEOUT_MS,
  type ChatCompletionOptions,
  completionId,
  contentText,
  DEFAULT_TIMEOUT_MS,
  HEALTH_TIMEOUT_MS,
} from "./types";

export interface OllamaOptions {
  fetch?: FetchFn;
  /** Context window for every request (default 8192). */
  numCtx?: number;
  /** How long Ollama keeps the model loaded after a request (default "15m"). */
  keepAlive?: string;
}

interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
  tool_name?: string;
  tool_call_id?: string;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export const OLLAMA_NUM_CTX = 8_192;

export function createOllamaLlm(config: LlmConfig, opts: OllamaOptions = {}): AiLlmClient {
  const { model } = config;
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const numCtx = opts.numCtx ?? OLLAMA_NUM_CTX;
  const keepAlive = opts.keepAlive ?? "15m";
  const unreachableHint = "Start Ollama (open the Ollama app or run `ollama serve`), or fix LLM_BASE_URL.";

  async function post(body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<OllamaChatResponse> {
    const result = await httpJson(`${baseUrl}/api/chat`, {
      body: { model, stream: false, think: false, keep_alive: keepAlive, ...body },
      timeoutMs,
      signal,
      fetchImpl: opts.fetch,
      service: "Ollama",
      unreachableHint,
    });
    if (!result.ok) throw httpError(result, model);
    if (!isRecord(result.body)) throw new LlmError("bad_response", "Ollama returned a non-JSON reply");
    return result.body as OllamaChatResponse;
  }

  async function complete(messages: LlmMessage[], callOpts: LlmCallOptions, format?: unknown): Promise<Completion> {
    const reply = await post(
      {
        messages,
        ...(format === undefined ? {} : { format }),
        options: {
          temperature: callOpts.temperature ?? 0.2,
          num_predict: callOpts.maxTokens ?? (format === undefined ? 512 : 1_024),
          num_ctx: numCtx,
        },
      },
      callOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      callOpts.signal,
    );
    const content = reply.message?.content;
    if (typeof content !== "string") throw new LlmError("bad_response", "Ollama reply has no message content");
    return { content, truncated: reply.done_reason === "length" };
  }

  return {
    provider: "ollama",
    model,

    async chat(messages, callOpts = {}) {
      const { content } = await complete(messages, callOpts);
      if (content.trim() === "") throw new LlmError("bad_response", "The model returned an empty reply");
      return content;
    },

    json<T>(messages: LlmMessage[], schema: z.ZodType<T>, callOpts: LlmCallOptions = {}): Promise<T> {
      const send = (msgs: LlmMessage[], format: StructuredFormat, o: LlmCallOptions) =>
        complete(msgs, o, forGrammar(closeObjects(format.schema)));
      return structuredCall(send, messages, schema, { temperature: 0.1, ...callOpts });
    },

    async health(): Promise<LlmHealth> {
      try {
        const result = await httpJson(`${baseUrl}/api/tags`, {
          timeoutMs: HEALTH_TIMEOUT_MS,
          fetchImpl: opts.fetch,
          service: "Ollama",
          unreachableHint,
        });
        if (!result.ok) return { reachable: false, model, detail: `Ollama answered HTTP ${result.status} on /api/tags` };
        const models = (isRecord(result.body) && Array.isArray(result.body.models) ? result.body.models : []) as Array<{
          name?: unknown;
          model?: unknown;
        }>;
        const pulled = models.some((m) => [m.name, m.model].some((n) => typeof n === "string" && sameModel(n, model)));
        if (!pulled) return { reachable: false, model, detail: `Model ${model} is not pulled. Run: ollama pull ${model}` };
        return { reachable: true, model };
      } catch (err) {
        return { reachable: false, model, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async chatCompletion(request: ChatRequestDTO, callOpts: ChatCompletionOptions = {}): Promise<ChatResponseDTO> {
      const { messages, tools } = toOllamaChat(request);
      const format =
        request.response_format?.type === "json_schema"
          ? forGrammar(request.response_format.json_schema.schema)
          : request.response_format?.type === "json_object"
            ? "json"
            : undefined;
      const reply = await post(
        {
          messages,
          ...(tools ? { tools } : {}),
          ...(format === undefined ? {} : { format }),
          options: {
            temperature: request.temperature ?? 0.3,
            num_predict: request.max_tokens ?? 1_024,
            num_ctx: numCtx,
          },
        },
        callOpts.timeoutMs ?? CHAT_PROXY_TIMEOUT_MS,
        callOpts.signal,
      );
      return toChatResponse(reply, model);
    },
  };
}

function httpError(result: HttpResult, model: string): LlmError {
  const message = serverError(result);
  if (result.status === 404 && /not found|pull/i.test(message)) {
    return new LlmError("model_missing", `Model ${model} is not pulled. Run: ollama pull ${model}`);
  }
  return new LlmError("http", `Ollama answered HTTP ${result.status}: ${message}`);
}

/** "gemma4" matches "gemma4:latest"; tags must match otherwise. */
function sameModel(name: string, wanted: string): boolean {
  const norm = (s: string) => (s.includes(":") ? s : `${s}:latest`).toLowerCase();
  return norm(name) === norm(wanted);
}

/** OpenAI chat.completions messages and tools -> Ollama /api/chat. */
export function toOllamaChat(request: ChatRequestDTO): { messages: OllamaMessage[]; tools?: unknown[] } {
  const toolNames = new Map<string, string>();
  const messages: OllamaMessage[] = request.messages.map((m) => {
    const content = contentText(m.content);
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) toolNames.set(call.id, call.function.name);
      return {
        role: "assistant",
        content,
        tool_calls: m.tool_calls.map((call) => ({
          function: { name: call.function.name, arguments: parseArguments(call.function.arguments) },
        })),
      };
    }
    if (m.role === "tool") {
      const name = m.name ?? (m.tool_call_id ? toolNames.get(m.tool_call_id) : undefined);
      return {
        role: "tool",
        content,
        ...(name ? { tool_name: name } : {}),
        ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
      };
    }
    return { role: m.role, content };
  });

  let tools: unknown[] | undefined = request.tools?.length ? request.tools : undefined;
  const choice = request.tool_choice;
  if (tools && choice === "none") tools = undefined;
  if (tools && typeof choice === "object") {
    const only = request.tools?.filter((t) => t.function.name === choice.function.name);
    if (only?.length) tools = only;
  }
  if (tools && (choice === "required" || typeof choice === "object")) {
    messages.push({ role: "system", content: "Answer by calling one of the provided tools." });
  }
  return { messages, tools };
}

function toChatResponse(reply: OllamaChatResponse, model: string): ChatResponseDTO {
  const calls: ChatToolCallDTO[] = (reply.message?.tool_calls ?? []).map((call, i) => {
    const args = call.function?.arguments;
    return {
      id: call.id ?? `call_${i}_${globalThis.crypto.randomUUID().slice(0, 8)}`,
      type: "function",
      function: { name: call.function?.name ?? "", arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
    };
  });
  const content = reply.message?.content ?? "";
  const promptTokens = reply.prompt_eval_count ?? 0;
  const completionTokens = reply.eval_count ?? 0;
  return {
    id: completionId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: calls.length && content === "" ? null : content,
          ...(calls.length ? { tool_calls: calls } : {}),
        },
        finish_reason: calls.length ? "tool_calls" : reply.done_reason === "length" ? "length" : "stop",
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
}

function parseArguments(args: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
