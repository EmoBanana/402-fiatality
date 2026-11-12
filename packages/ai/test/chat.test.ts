import type { LlmConfig } from "@p402/gateway/context";
import type { ChatRequestDTO } from "@p402/shared";
import { afterEach, describe, expect, it } from "vitest";
import { chatProxy } from "../src/chat/proxy";
import { createLlm } from "../src/llm";
import { isLlmError } from "../src/llm/errors";
import { createMockLlm } from "../src/llm/mock";
import { downServerUrl, type FakeHandler, type FakeServer, fakeFetch, ollamaReply, openAiReply, startFakeServer } from "./helpers/fake-llm-server";

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fake(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}
const cfg = (provider: LlmConfig["provider"], baseUrl = "http://localhost:11434"): LlmConfig => ({ provider, baseUrl, model: "gemma4:12b", apiKey: null });

const TOOLS: ChatRequestDTO["tools"] = [
  {
    type: "function",
    function: { name: "executeQuery", description: "Run a query", parameters: { type: "object", properties: { sql: { type: "string" } } } },
  },
  { type: "function", function: { name: "addWidget", parameters: { type: "object", properties: {} } } },
];

describe("chatProxy", () => {
  it("answers offline in mock mode with an OpenAI-shaped completion", async () => {
    const out = await chatProxy(createLlm(cfg("mock")), { messages: [{ role: "user", content: "Which seller voids most?" }], tools: TOOLS, stream: true });
    expect(out).toMatchObject({ object: "chat.completion", model: "mock" });
    expect(out.choices).toHaveLength(1);
    expect(out.choices[0]!.finish_reason).toBe("stop");
    expect(out.choices[0]!.message.tool_calls).toBeUndefined();
    expect(out.choices[0]!.message.content).toMatch(/offline mock model.*Which seller voids most\?/);
  });

  it("returns schema-shaped JSON in mock mode when asked for json_schema", async () => {
    const out = await chatProxy(createLlm(cfg("mock")), {
      messages: [{ role: "user", content: "plan" }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "plan", schema: { type: "object", properties: { steps: { type: "array", items: { type: "string" } }, done: { type: "boolean" } }, required: ["steps", "done"] } },
      },
    });
    expect(JSON.parse(out.choices[0]!.message.content!)).toEqual({ steps: [], done: false });
  });

  it("translates tools and tool results for Ollama and maps tool calls back", async () => {
    const server = await fake(() =>
      ollamaReply("", { message: { tool_calls: [{ function: { name: "executeQuery", arguments: { sql: "select 1" } } }] }, prompt_eval_count: 50, eval_count: 9 }),
    );
    const out = await chatProxy(createLlm(cfg("ollama", server.url)), {
      messages: [
        { role: "system", content: "You build dashboards." },
        { role: "user", content: "Spend by seller?" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "executeQuery", arguments: '{"sql":"select 0"}' } }] },
        { role: "tool", tool_call_id: "call_a", content: '{"rows":[]}' },
      ],
      tools: TOOLS,
      temperature: 0.1,
      max_tokens: 300,
      stream: true,
    });

    const body = server.requests[0]!.body;
    expect(server.requests[0]!.path).toBe("/api/chat");
    expect(body).toMatchObject({ model: "gemma4:12b", stream: false, think: false, options: { temperature: 0.1, num_predict: 300, num_ctx: 8192 } });
    expect(body.tools).toEqual(TOOLS);
    expect(body.messages[2]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "executeQuery", arguments: { sql: "select 0" } } }] });
    expect(body.messages[3]).toEqual({ role: "tool", content: '{"rows":[]}', tool_name: "executeQuery", tool_call_id: "call_a" });

    const choice = out.choices[0]!;
    expect(out.model).toBe("gemma4:12b");
    expect(choice.finish_reason).toBe("tool_calls");
    expect(choice.message.content).toBeNull();
    expect(choice.message.tool_calls).toEqual([{ id: expect.stringMatching(/^call_/), type: "function", function: { name: "executeQuery", arguments: '{"sql":"select 1"}' } }]);
    expect(out.usage).toEqual({ prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 });
  });

  it("maps tool_choice and response_format for Ollama", async () => {
    const server = await fake(() => ollamaReply('{"ok":true}'));
    const llm = createLlm(cfg("ollama", server.url));
    await chatProxy(llm, { messages: [{ role: "user", content: "x" }], tools: TOOLS, tool_choice: "none", response_format: { type: "json_object" } });
    await chatProxy(llm, { messages: [{ role: "user", content: "x" }], tools: TOOLS, tool_choice: { type: "function", function: { name: "addWidget" } } });
    const [first, second] = server.requests.map((r) => r.body);
    expect(first.tools).toBeUndefined();
    expect(first.format).toBe("json");
    expect(second.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(["addWidget"]);
    expect(second.messages.at(-1)).toEqual({ role: "system", content: "Answer by calling one of the provided tools." });
  });

  it("forwards to an OpenAI-compatible server with the configured model and stream off", async () => {
    const server = await fake(() => openAiReply("Hi!"));
    const request = { messages: [{ role: "user" as const, content: "hi" }], stream: true, model: "gpt-4o" } as ChatRequestDTO;
    const out = await chatProxy(createLlm(cfg("openai", server.url)), request);
    expect(server.requests[0]!.path).toBe("/v1/chat/completions");
    expect(server.requests[0]!.body).toMatchObject({ model: "gemma4:12b", stream: false });
    expect(out.choices[0]!.message.content).toBe("Hi!");
  });

  it("forwards to a versioned base URL such as Gemini's without adding /v1", async () => {
    const api = fakeFetch(() => openAiReply("Channel3 leads on spend."));
    const llm = createLlm(
      { provider: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/", model: "gemma-4-26b-a4b-it", apiKey: "test-key" },
      { fetch: api.fetch },
    );
    const out = await chatProxy(llm, { messages: [{ role: "user", content: "Spend by seller?" }], tools: TOOLS, tool_choice: "auto", stream: true });

    expect(api.requests).toHaveLength(1);
    const req = api.requests[0]!;
    expect(`${req.method} ${req.url}`).toBe("POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    expect(req.headers.authorization).toBe("Bearer test-key");
    expect(req.body).toMatchObject({ model: "gemma-4-26b-a4b-it", stream: false, tools: TOOLS, tool_choice: "auto" });
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0]!.message.content).toBe("Channel3 leads on spend.");
  });

  it("falls back to plain chat for clients without chat completions", async () => {
    const plain = createMockLlm({ replies: ["plain answer"] });
    const { chatCompletion: _drop, ...withoutCompletion } = plain;
    const out = await chatProxy(withoutCompletion, { messages: [{ role: "user", content: "hi" }] });
    expect(out.choices[0]!.message.content).toBe("plain answer");
  });

  it("surfaces an unreachable model as an LlmError with an HTTP status", async () => {
    const err = await chatProxy(createLlm(cfg("ollama", await downServerUrl())), { messages: [{ role: "user", content: "hi" }] }).catch(
      (e: unknown) => e,
    );
    expect(isLlmError(err, "unreachable")).toBe(true);
    expect((err as { status: number }).status).toBe(503);
  });
});
