/**
 * A scriptable stand-in for Ollama / an OpenAI-compatible server on 127.0.0.1, ports 4300-4399, plus a fetch
 * stand-in for hosted providers. Records every request; the handler decides each reply (status, JSON body, delay).
 */
import { createServer, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";

export interface FakeRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON (inspected loosely in tests). */
  body: any;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  text?: string;
  delayMs?: number;
}

export type FakeHandler = (req: FakeRequest, index: number) => FakeReply | Promise<FakeReply>;

export interface FakeServer {
  url: string;
  port: number;
  requests: FakeRequest[];
  close(): Promise<void>;
}

const PORT_MIN = 4300;
const PORT_MAX = 4399;
/** Ports this process already used; skipped while others are free. */
const used = new Set<number>();

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const record: FakeRequest = { method: req.method ?? "GET", path: req.url ?? "/", headers: req.headers, body };
      const index = requests.push(record) - 1;
      try {
        const reply = await handler(record, index);
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (res.destroyed || res.writableEnded) return;
        // No keep-alive: a pooled socket to a port a later test reuses would fail with ECONNRESET.
        res.setHeader("connection", "close");
        if (reply.text !== undefined) {
          res.writeHead(reply.status ?? 200, { "content-type": "text/plain" }).end(reply.text);
        } else {
          res.writeHead(reply.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(reply.json ?? {}));
        }
      } catch (err) {
        if (!res.destroyed) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  const port = await listen(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * An LLM server that is down: a port in 4300-4399 that drops every connection. It stays reserved for the
 * life of the test worker, so no other test can start a server there in the meantime.
 */
export async function downServerUrl(): Promise<string> {
  const server = createNetServer((socket) => socket.destroy());
  const port = await listen(server);
  server.unref();
  return `http://127.0.0.1:${port}`;
}

async function listen(server: NetServer): Promise<number> {
  const span = PORT_MAX - PORT_MIN + 1;
  const start = Math.floor(Math.random() * span);
  const order = Array.from({ length: span }, (_, i) => PORT_MIN + ((start + i) % span));
  for (const port of [...order.filter((p) => !used.has(p)), ...order.filter((p) => used.has(p))]) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve(true);
      });
    });
    if (ok) {
      used.add(port);
      return port;
    }
  }
  throw new Error("No free port in 4300-4399");
}

/** An Ollama /api/chat reply. */
export function ollamaReply(content: string, extra: Record<string, unknown> = {}): FakeReply {
  return {
    json: {
      model: "gemma4:12b",
      created_at: new Date().toISOString(),
      message: { role: "assistant", content, ...((extra.message as object) ?? {}) },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 30,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "message")),
    },
  };
}

export function ollamaTags(...names: string[]): FakeReply {
  return { json: { models: names.map((name) => ({ name, model: name, size: 1, details: { family: "gemma4" } })) } };
}

/** An OpenAI chat.completions reply. */
export function openAiReply(content: string): FakeReply {
  return {
    json: {
      id: "chatcmpl-test",
      object: "chat.completion",
      created: 1,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    },
  };
}

/** An OpenAI GET /models list. */
export function openAiModels(...ids: string[]): FakeReply {
  return { json: { object: "list", data: ids.map((id) => ({ id, object: "model", owned_by: "test" })) } };
}

export interface FakeFetchRequest extends FakeRequest {
  /** The full URL, e.g. https://api.groq.com/openai/v1/chat/completions. */
  url: string;
}

/**
 * A fetch stand-in for hosted providers (Groq, OpenRouter, Gemini), so tests can check the exact URLs sent
 * without a network. Records every request; the handler decides each reply (delayMs is ignored).
 */
export function fakeFetch(handler: FakeHandler): { fetch: typeof fetch; requests: FakeFetchRequest[] } {
  const requests: FakeFetchRequest[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const { pathname, search } = new URL(url);
    const raw = typeof init.body === "string" ? init.body : "";
    const record: FakeFetchRequest = {
      method: init.method ?? "GET",
      url,
      path: pathname + search,
      headers: { ...(init.headers as Record<string, string> | undefined) },
      body: raw ? JSON.parse(raw) : null,
    };
    const reply = await handler(record, requests.push(record) - 1);
    const type = reply.text === undefined ? "application/json" : "text/plain";
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), { status: reply.status ?? 200, headers: { "content-type": type } });
  };
  return { fetch: fetchImpl as typeof fetch, requests };
}

/** Text of the last message of an /api/chat or /v1/chat/completions request. */
export function lastMessage(req: FakeRequest): string {
  const messages = (req.body?.messages ?? []) as Array<{ content?: string }>;
  return messages[messages.length - 1]?.content ?? "";
}
