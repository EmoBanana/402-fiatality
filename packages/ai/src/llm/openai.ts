/**
 * Any OpenAI-compatible server: POST {root}/chat/completions with `response_format: json_schema`
 * for structured output, GET {root}/models for health. {root} comes from LLM_BASE_URL (openAiApiRoot).
 */
import type { LlmCallOptions, LlmConfig, LlmHealth, LlmMessage } from "@p402/gateway/context";
import type { ChatRequestDTO, ChatResponseDTO } from "@p402/shared";
import type { z } from "zod";
import { LlmError } from "./errors";
import { type FetchFn, type HttpResult, httpJson, serverError } from "./http";
import { type Completion, type StructuredFormat, structuredCall } from "./json";
import { closeObjects, isRecord, isStrictCompatible } from "./schema";
import { type AiLlmClient, CHAT_PROXY_TIMEOUT_MS, type ChatCompletionOptions, DEFAULT_TIMEOUT_MS, HEALTH_TIMEOUT_MS } from "./types";

export interface OpenAiOptions {
  fetch?: FetchFn;
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
}

/** A path segment that names an API version: v1, v2, v1beta, v1alpha, v1beta1. */
const VERSION_SEGMENT = /^v\d+(?:alpha|beta)?\d*$/i;

/**
 * The URL that /chat/completions and /models hang off. A base URL whose path already names an API version is
 * used as given (Groq …/openai/v1, OpenRouter …/api/v1, Gemini …/v1beta/openai); any other gets /v1 (Ollama
 * http://localhost:11434, https://api.openai.com). Trailing slashes are ignored.
 */
export function openAiApiRoot(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, "");
  let path = root;
  try {
    path = new URL(root).pathname;
  } catch {
    // Not an absolute URL: look for a version in the text as given.
  }
  return path.split("/").some((segment) => VERSION_SEGMENT.test(segment)) ? root : `${root}/v1`;
}

export function createOpenAiLlm(config: LlmConfig, opts: OpenAiOptions = {}): AiLlmClient {
  const { model } = config;
  const apiRoot = openAiApiRoot(config.baseUrl);
  const headers: Record<string, string> = config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {};
  const unreachableHint = "Check LLM_BASE_URL and that the server is running.";

  async function call(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<HttpResult> {
    return httpJson(`${apiRoot}${path}`, {
      body,
      headers,
      timeoutMs,
      signal,
      fetchImpl: opts.fetch,
      service: "The LLM server",
      unreachableHint,
    });
  }

  async function complete(messages: LlmMessage[], callOpts: LlmCallOptions, responseFormat?: unknown): Promise<Completion> {
    const result = await call(
      "/chat/completions",
      {
        model,
        messages,
        stream: false,
        temperature: callOpts.temperature ?? 0.2,
        max_tokens: callOpts.maxTokens ?? (responseFormat === undefined ? 512 : 1_024),
        ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
      },
      callOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      callOpts.signal,
    );
    if (!result.ok) throw httpError(result, model);
    const choice = (result.body as ChatCompletionBody | null)?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") throw new LlmError("bad_response", "The LLM server reply has no message content");
    return { content, truncated: choice?.finish_reason === "length" };
  }

  return {
    provider: "openai",
    model,

    async chat(messages, callOpts = {}) {
      const { content } = await complete(messages, callOpts);
      if (content.trim() === "") throw new LlmError("bad_response", "The model returned an empty reply");
      return content;
    },

    json<T>(messages: LlmMessage[], schema: z.ZodType<T>, callOpts: LlmCallOptions = {}): Promise<T> {
      const send = (msgs: LlmMessage[], format: StructuredFormat, o: LlmCallOptions) => {
        const closed = closeObjects(format.schema);
        const strict = isStrictCompatible(closed);
        return complete(msgs, o, {
          type: "json_schema",
          json_schema: { name: format.name, schema: strict ? closed : format.schema, strict },
        });
      };
      return structuredCall(send, messages, schema, { temperature: 0.1, ...callOpts });
    },

    async health(): Promise<LlmHealth> {
      try {
        const result = await httpJson(`${apiRoot}/models`, {
          headers,
          timeoutMs: HEALTH_TIMEOUT_MS,
          fetchImpl: opts.fetch,
          service: "The LLM server",
          unreachableHint,
        });
        if (result.status === 401 || result.status === 403) {
          return { reachable: false, model, detail: `The LLM server rejected the API key (HTTP ${result.status}); check LLM_API_KEY` };
        }
        if (result.status === 404) return { reachable: true, model, detail: "The server does not list models; assuming the model exists" };
        if (!result.ok) return { reachable: false, model, detail: `The LLM server answered HTTP ${result.status}: ${serverError(result)}` };
        const data = isRecord(result.body) && Array.isArray(result.body.data) ? (result.body.data as Array<{ id?: unknown }>) : [];
        const ids = data.map((m) => m.id).filter((id): id is string => typeof id === "string");
        // Gemini lists "models/gemma-4-26b-a4b-it" for the "gemma-4-26b-a4b-it" that chat requests name.
        const bare = (id: string) => id.replace(/^models\//, "");
        if (ids.length > 0 && !ids.some((id) => bare(id) === bare(model))) {
          return { reachable: false, model, detail: `Model ${model} is not offered by the server (has: ${ids.slice(0, 5).join(", ")})` };
        }
        return { reachable: true, model };
      } catch (err) {
        return { reachable: false, model, detail: err instanceof Error ? err.message : String(err) };
      }
    },

    async chatCompletion(request: ChatRequestDTO, callOpts: ChatCompletionOptions = {}): Promise<ChatResponseDTO> {
      const result = await call(
        "/chat/completions",
        { ...request, model, stream: false },
        callOpts.timeoutMs ?? CHAT_PROXY_TIMEOUT_MS,
        callOpts.signal,
      );
      if (!result.ok) throw httpError(result, model);
      const body = result.body as ChatResponseDTO | null;
      if (!body || !Array.isArray(body.choices) || body.choices.length === 0) {
        throw new LlmError("bad_response", "The LLM server reply has no choices");
      }
      return { ...body, object: "chat.completion" };
    },
  };
}

function httpError(result: HttpResult, model: string): LlmError {
  const message = serverError(result);
  if (result.status === 401 || result.status === 403) {
    return new LlmError("http", `The LLM server rejected the API key (HTTP ${result.status}); check LLM_API_KEY`);
  }
  if (result.status === 404 && /model/i.test(message)) {
    return new LlmError("model_missing", `Model ${model} is not available on the LLM server: ${message}`);
  }
  return new LlmError("http", `The LLM server answered HTTP ${result.status}: ${message}`);
}
