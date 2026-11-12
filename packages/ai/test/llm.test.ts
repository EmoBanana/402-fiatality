import type { LlmConfig } from "@p402/gateway/context";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlm } from "../src/llm";
import { isLlmError, LlmError } from "../src/llm/errors";
import { parseJsonReply } from "../src/llm/json";
import { createMockLlm } from "../src/llm/mock";
import { openAiApiRoot } from "../src/llm/openai";
import {
  downServerUrl,
  type FakeHandler,
  type FakeServer,
  fakeFetch,
  lastMessage,
  ollamaReply,
  ollamaTags,
  openAiModels,
  openAiReply,
  startFakeServer,
} from "./helpers/fake-llm-server";

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function fake(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

const config = (provider: LlmConfig["provider"], baseUrl: string, extra: Partial<LlmConfig> = {}): LlmConfig => ({
  provider,
  baseUrl,
  model: "gemma4:12b",
  apiKey: null,
  ...extra,
});

const sumSchema = z.object({ sum: z.number().int(), color: z.enum(["red", "blue"]) });

async function rejection(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof LlmError) return err;
    throw err;
  }
  throw new Error("expected a rejection");
}

describe("ollama provider", () => {
  it("sends the JSON schema as format, thinking off, keep_alive and fixed options", async () => {
    const server = await fake(() => ollamaReply('{"sum":42,"color":"blue"}'));
    const llm = createLlm(config("ollama", server.url));
    const out = await llm.json([{ role: "user", content: "17 + 25? Colour of the sky?" }], sumSchema, { temperature: 0, maxTokens: 50 });

    expect(out).toEqual({ sum: 42, color: "blue" });
    const req = server.requests[0]!;
    expect(req.path).toBe("/api/chat");
    expect(req.body).toMatchObject({
      model: "gemma4:12b",
      stream: false,
      think: false,
      keep_alive: "15m",
      options: { temperature: 0, num_predict: 50, num_ctx: 8192 },
    });
    expect(req.body.format).toMatchObject({
      type: "object",
      properties: { sum: { type: "integer" }, color: { type: "string", enum: ["red", "blue"] } },
      required: ["sum", "color"],
      additionalProperties: false,
    });
    // Zod's safe-integer bounds would bloat Ollama's grammar; zod validates them afterwards instead.
    expect(req.body.format.properties.sum.minimum).toBeUndefined();
    expect(req.body.format.$schema).toBeUndefined();
    expect(JSON.stringify(req.body)).not.toContain("<|think|>");
  });

  it("retries once with the validation error appended, then succeeds", async () => {
    const server = await fake((_req, i) => ollamaReply(i === 0 ? '{"sum":"forty-two","color":"blue"}' : '{"sum":42,"color":"blue"}'));
    const llm = createLlm(config("ollama", server.url));
    const out = await llm.json([{ role: "user", content: "17 + 25?" }], sumSchema);

    expect(out.sum).toBe(42);
    expect(server.requests).toHaveLength(2);
    const retry = server.requests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(retry).toHaveLength(3);
    expect(retry[1]).toEqual({ role: "assistant", content: '{"sum":"forty-two","color":"blue"}' });
    expect(retry[2]!.role).toBe("user");
    expect(retry[2]!.content).toMatch(/sum: .*expected number/);
    expect(retry[2]!.content).toMatch(/corrected JSON/);
  });

  it("gives up with invalid_output after two bad replies", async () => {
    const server = await fake(() => ollamaReply("Sure! The answer is 42."));
    const err = await rejection(createLlm(config("ollama", server.url)).json([{ role: "user", content: "?" }], sumSchema));
    expect(err.code).toBe("invalid_output");
    expect(err.status).toBe(502);
    expect(server.requests).toHaveLength(2);
  });

  it("tells the model when its reply was cut off", async () => {
    const server = await fake((_req, i) =>
      i === 0 ? ollamaReply('{"sum":4', { done_reason: "length" }) : ollamaReply('{"sum":4,"color":"red"}'),
    );
    const out = await createLlm(config("ollama", server.url)).json([{ role: "user", content: "?" }], sumSchema);
    expect(out).toEqual({ sum: 4, color: "red" });
    expect(lastMessage(server.requests[1]!)).toMatch(/cut off/);
  });

  it("accepts JSON wrapped in a code fence", async () => {
    const server = await fake(() => ollamaReply('```json\n{"sum":1,"color":"red"}\n```'));
    expect(await createLlm(config("ollama", server.url)).json([{ role: "user", content: "?" }], sumSchema)).toEqual({ sum: 1, color: "red" });
  });

  it("returns chat text and rejects an empty reply", async () => {
    const server = await fake((_req, i) => ollamaReply(i === 0 ? "Hello there." : "   "));
    const llm = createLlm(config("ollama", server.url));
    expect(await llm.chat([{ role: "user", content: "hi" }])).toBe("Hello there.");
    expect(server.requests[0]!.body.format).toBeUndefined();
    expect((await rejection(llm.chat([{ role: "user", content: "hi" }]))).code).toBe("bad_response");
  });

  it("times out with a clear error", async () => {
    const server = await fake(() => ({ ...ollamaReply("late"), delayMs: 1_500 }));
    const started = Date.now();
    const err = await rejection(createLlm(config("ollama", server.url)).chat([{ role: "user", content: "hi" }], { timeoutMs: 150 }));
    expect(err.code).toBe("timeout");
    expect(err.message).toMatch(/did not answer within 0\.2 s/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("stops when the caller aborts", async () => {
    const server = await fake(() => ({ ...ollamaReply("late"), delayMs: 1_500 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const err = await rejection(createLlm(config("ollama", server.url)).chat([{ role: "user", content: "hi" }], { signal: controller.signal }));
    expect(err.code).toBe("aborted");
  });

  it("explains how to start Ollama when it is not running", async () => {
    const err = await rejection(createLlm(config("ollama", await downServerUrl())).chat([{ role: "user", content: "hi" }]));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/Ollama is not reachable at http:\/\/127\.0\.0\.1:43\d\d/);
    expect(err.message).toMatch(/ollama serve/);
  });

  it("maps a missing model to `ollama pull`", async () => {
    const server = await fake(() => ({ status: 404, json: { error: 'model "gemma4:12b" not found, try pulling it first' } }));
    const err = await rejection(createLlm(config("ollama", server.url)).chat([{ role: "user", content: "hi" }]));
    expect(err.code).toBe("model_missing");
    expect(err.message).toBe("Model gemma4:12b is not pulled. Run: ollama pull gemma4:12b");
  });

  it("reports other HTTP errors with Ollama's message", async () => {
    const server = await fake(() => ({ status: 500, json: { error: "out of memory" } }));
    const err = await rejection(createLlm(config("ollama", server.url)).chat([{ role: "user", content: "hi" }]));
    expect(err.code).toBe("http");
    expect(err.message).toMatch(/HTTP 500: out of memory/);
  });

  describe("health", () => {
    it("is reachable when the model is pulled", async () => {
      const server = await fake(() => ollamaTags("llama3:8b", "gemma4:12b"));
      expect(await createLlm(config("ollama", server.url)).health()).toEqual({ reachable: true, model: "gemma4:12b" });
      expect(server.requests[0]).toMatchObject({ method: "GET", path: "/api/tags" });
    });

    it("says which model to pull when it is missing", async () => {
      const server = await fake(() => ollamaTags("gemma4:e4b-it-qat"));
      const health = await createLlm(config("ollama", server.url)).health();
      expect(health.reachable).toBe(false);
      expect(health.detail).toBe("Model gemma4:12b is not pulled. Run: ollama pull gemma4:12b");
    });

    it("treats an untagged model as :latest", async () => {
      const server = await fake(() => ollamaTags("gemma4:latest"));
      expect((await createLlm(config("ollama", server.url, { model: "gemma4" })).health()).reachable).toBe(true);
    });

    it("says to start Ollama when it is down", async () => {
      const health = await createLlm(config("ollama", await downServerUrl())).health();
      expect(health.reachable).toBe(false);
      expect(health.detail).toMatch(/not reachable.*Start Ollama/);
    });
  });
});

describe("openai-compatible provider", () => {
  it("sends response_format json_schema (strict when possible) with the API key", async () => {
    const server = await fake(() => openAiReply('{"sum":42,"color":"blue"}'));
    const llm = createLlm(config("openai", `${server.url}/v1/`, { model: "gpt-test", apiKey: "sk-test" }));
    expect(await llm.json([{ role: "user", content: "?" }], sumSchema, { maxTokens: 64 })).toEqual({ sum: 42, color: "blue" });

    const req = server.requests[0]!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-test");
    expect(req.body).toMatchObject({ model: "gpt-test", stream: false, max_tokens: 64 });
    expect(req.body.response_format).toMatchObject({
      type: "json_schema",
      json_schema: { name: "reply", strict: true, schema: { type: "object", additionalProperties: false, required: ["sum", "color"] } },
    });
  });

  it("drops strict mode for schemas with optional fields", async () => {
    const server = await fake(() => openAiReply('{"a":1}'));
    const llm = createLlm(config("openai", server.url));
    await llm.json([{ role: "user", content: "?" }], z.object({ a: z.number(), b: z.string().optional() }));
    expect(server.requests[0]!.body.response_format.json_schema.strict).toBe(false);
  });

  it("checks health against /v1/models", async () => {
    const ok = await fake(() => ({ json: { data: [{ id: "gpt-test" }] } }));
    expect((await createLlm(config("openai", ok.url, { model: "gpt-test" })).health()).reachable).toBe(true);
    const denied = await fake(() => ({ status: 401, json: { error: { message: "bad key" } } }));
    const health = await createLlm(config("openai", denied.url)).health();
    expect(health.reachable).toBe(false);
    expect(health.detail).toMatch(/LLM_API_KEY/);
  });

  // LLM_BASE_URL as each provider documents it, on a fake fetch so the full URLs can be checked.
  it.each([
    ["Ollama", "http://localhost:11434", "http://localhost:11434/v1", "gemma4:e4b-it-qat", "gemma4:e4b-it-qat"],
    ["Groq", "https://api.groq.com/openai/v1", "https://api.groq.com/openai/v1", "llama-3.1-8b-instant", "llama-3.1-8b-instant"],
    ["OpenRouter", "https://openrouter.ai/api/v1/", "https://openrouter.ai/api/v1", "google/gemma-3-27b-it", "google/gemma-3-27b-it"],
    [
      "Gemini",
      "https://generativelanguage.googleapis.com/v1beta/openai/",
      "https://generativelanguage.googleapis.com/v1beta/openai",
      "gemma-4-26b-a4b-it",
      "models/gemma-4-26b-a4b-it",
    ],
  ])("%s at %s: chat completions and the model list", async (_provider, baseUrl, root, model, listedAs) => {
    const api = fakeFetch((req) => (req.path.endsWith("/models") ? openAiModels("text-embedding-test", listedAs) : openAiReply('{"sum":42,"color":"blue"}')));
    const llm = createLlm(config("openai", baseUrl, { model, apiKey: "test-key" }), { fetch: api.fetch });

    expect(await llm.json([{ role: "user", content: "?" }], sumSchema)).toEqual({ sum: 42, color: "blue" });
    expect(await llm.health()).toEqual({ reachable: true, model });
    expect(api.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`POST ${root}/chat/completions`, `GET ${root}/models`]);
    expect(api.requests[0]!.headers.authorization).toBe("Bearer test-key");
  });

  it("matches Gemini's models/ ids but still flags a model the server lacks", async () => {
    const api = fakeFetch(() => openAiModels("models/gemini-2.5-flash", "models/gemma-4-31b-it"));
    const gemini = (model: string) =>
      createLlm(config("openai", "https://generativelanguage.googleapis.com/v1beta/openai", { model }), { fetch: api.fetch });
    expect((await gemini("gemma-4-31b-it").health()).reachable).toBe(true);
    expect((await gemini("models/gemma-4-31b-it").health()).reachable).toBe(true);
    const missing = await gemini("gemma-4-26b-a4b-it").health();
    expect(missing.reachable).toBe(false);
    expect(missing.detail).toMatch(/Model gemma-4-26b-a4b-it is not offered by the server/);
  });
});

describe("openAiApiRoot", () => {
  it.each([
    ["http://localhost:11434", "http://localhost:11434/v1"],
    ["http://localhost:11434/", "http://localhost:11434/v1"],
    ["http://localhost:11434/v1/", "http://localhost:11434/v1"],
    ["https://api.openai.com", "https://api.openai.com/v1"],
    ["https://api.groq.com/openai/v1/", "https://api.groq.com/openai/v1"],
    ["https://openrouter.ai/api/v1", "https://openrouter.ai/api/v1"],
    ["https://generativelanguage.googleapis.com/v1beta/openai", "https://generativelanguage.googleapis.com/v1beta/openai"],
    ["https://generativelanguage.googleapis.com/v1beta/openai//", "https://generativelanguage.googleapis.com/v1beta/openai"],
    // A path prefix without a version (a reverse proxy), and a version-looking host name, still get /v1.
    ["http://gpu-box:8080/ollama", "http://gpu-box:8080/ollama/v1"],
    ["http://v1.lan:11434", "http://v1.lan:11434/v1"],
  ])("%s -> %s", (baseUrl, root) => {
    expect(openAiApiRoot(baseUrl)).toBe(root);
  });
});

describe("mock provider", () => {
  it("needs no network and reports itself as the offline mock", async () => {
    const llm = createLlm(config("mock", "http://localhost:1"));
    expect(llm.provider).toBe("mock");
    expect(llm.model).toBe("mock");
    expect(await llm.health()).toMatchObject({ reachable: true, model: "mock" });
    expect(await llm.chat([{ role: "user", content: "What did we spend?" }])).toMatch(/offline mock model/);
  });

  it("answers json() with a deterministic minimal instance of the schema", async () => {
    const llm = createMockLlm();
    const schema = z.object({
      thought: z.string(),
      action: z.enum(["search", "details", "finish"]),
      args: z.object({ query: z.string().optional(), limit: z.number().int().min(3) }),
      tags: z.array(z.string()).min(1),
      done: z.boolean(),
      maybe: z.string().nullable(),
    });
    const a = await llm.json([{ role: "user", content: "go" }], schema);
    expect(a).toEqual({ thought: "", action: "search", args: { limit: 3 }, tags: [""], done: false, maybe: "" });
    expect(await llm.json([{ role: "user", content: "go" }], schema)).toEqual(a);
  });

  it("plays scripted replies in order, retrying like a real provider", async () => {
    const llm = createMockLlm({ replies: ["not json", { sum: 2, color: "red" }, "second chat"] });
    expect(await llm.json([{ role: "user", content: "?" }], sumSchema)).toEqual({ sum: 2, color: "red" });
    expect(await llm.chat([{ role: "user", content: "?" }])).toBe("second chat");
  });
});

describe("parseJsonReply", () => {
  it("finds the JSON inside prose", () => {
    expect(parseJsonReply('Here you go: {"a":1} hope that helps')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonReply("")).toMatchObject({ ok: false });
    expect(isLlmError(new LlmError("timeout", "x"), "timeout")).toBe(true);
  });
});
