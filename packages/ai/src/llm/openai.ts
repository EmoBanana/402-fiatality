/**
 * Any OpenAI-compatible server: POST {root}/chat/completions with `response_format: json_schema`
 * for structured output, GET {root}/models for health. {root} comes from LLM_BASE_URL (openAiApiRoot).
 *
 * Hosted Gemma 4 (Gemini API) needs two allowances, harmless elsewhere: a share of requests fail with a 500
 * that the same request then passes, so 5xx answers are retried; and the model reasons out loud before
 * answering (`<thought>…</thought>`, which no request option turns off), so that block is removed and a
 * reasoning that used up max_tokens is asked once more with room to finish.
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
  /** First pause before retrying a 5xx answer (default 500 ms; tests shorten it). */
  retryDelayMs?: number;
}

interface ChatCompletionBody {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
}

/** Retries for a 500/502/503/504 answer (Gemini fails a share of Gemma 4 requests that pass when repeated). */
const SERVER_ERROR_RETRIES = 3;
/** Extra output tokens when a model's reasoning used up max_tokens before it answered. */
export const THINKING_ROOM_TOKENS = 2_048;

/** Reasoning a server puts before the answer: Gemma 4 on Gemini writes <thought>…</thought>, DeepSeek-style models <think>…</think>. */
const LEADING_THOUGHT = /^\s*<(thought|think)>[\s\S]*?(?:<\/\1>\s*|$)/;

/** The answer after a leading reasoning block; cutOff when the block never closed (the token limit came first). */
export function stripThought(content: string): { text: string; cutOff: boolean } {
  const match = LEADING_THOUGHT.exec(content);
  if (!match) return { text: content, cutOff: false };
  return { text: content.slice(match[0].length), cutOff: !match[0].trimEnd().endsWith(`</${match[1]}>`) };
}

/** The reply without each choice's leading reasoning; thoughtCutOff when a reasoning ran into the token limit. */
function withoutThoughts(body: ChatResponseDTO): { body: ChatResponseDTO; thoughtCutOff: boolean } {
  let thoughtCutOff = false;
  const choices = body.choices.map((choice) => {
    const content = choice?.message?.content;
    if (typeof content !== "string") return choice;
    const answer = stripThought(content);
    if (answer.cutOff && choice.finish_reason === "length") thoughtCutOff = true;
    return answer.text === content ? choice : { ...choice, message: { ...choice.message, content: answer.text } };
  });
  return { body: { ...body, choices }, thoughtCutOff };
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
      serverErrorRetries: SERVER_ERROR_RETRIES,
      retryDelayMs: opts.retryDelayMs,
    });
  }

  async function complete(messages: LlmMessage[], callOpts: LlmCallOptions, responseFormat?: unknown): Promise<Completion> {
    const maxTokens = callOpts.maxTokens ?? (responseFormat === undefined ? 512 : 1_024);
    const send = async (tokens: number) => {
      const result = await call(
        "/chat/completions",
        {
          model,
          messages,
          stream: false,
          temperature: callOpts.temperature ?? 0.2,
          max_tokens: tokens,
          ...(responseFormat === undefined ? {} : { response_format: responseFormat }),
        },
        callOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        callOpts.signal,
      );
      if (!result.ok) throw httpError(result, model);
      const choice = (result.body as ChatCompletionBody | null)?.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new LlmError("bad_response", "The LLM server reply has no message content");
      const truncated = choice?.finish_reason === "length";
      const answer = stripThought(content);
      return { content: answer.text, truncated, thoughtCutOff: answer.cutOff && truncated };
    };
    let reply = await send(maxTokens);
    if (reply.thoughtCutOff) reply = await send(maxTokens + THINKING_ROOM_TOKENS);
    return { content: reply.content, truncated: reply.truncated };
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
      const send = async (body: ChatRequestDTO) => {
        const result = await call(
          "/chat/completions",
          { ...body, model, stream: false },
          callOpts.timeoutMs ?? CHAT_PROXY_TIMEOUT_MS,
          callOpts.signal,
        );
        if (!result.ok) throw httpError(result, model);
        const reply = result.body as ChatResponseDTO | null;
        if (!reply || !Array.isArray(reply.choices) || reply.choices.length === 0) {
          throw new LlmError("bad_response", "The LLM server reply has no choices");
        }
        return withoutThoughts(reply);
      };
      let reply = await send(request);
      if (reply.thoughtCutOff && typeof request.max_tokens === "number") {
        reply = await send({ ...request, max_tokens: request.max_tokens + THINKING_ROOM_TOKENS });
      }
      return { ...reply.body, object: "chat.completion" };
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
