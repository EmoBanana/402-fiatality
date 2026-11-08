/** AG Grid AI Toolkit queries and the OpenAI-style chat proxy used by AG Studio (SPEC §7). */
import type { ChatRequestDTO, GridQueryRequestDTO } from "@p402/shared";
import { z } from "zod";
import type { RoutePlugin } from "../context";
import { parseInput } from "../http/errors";

/** Grid schemas/state and chat histories can be large; still bounded. */
const AI_BODY_LIMIT = 4 * 1024 * 1024;

const record = z.record(z.string(), z.unknown());

const gridQuerySchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  schema: record,
  state: record,
});

const toolCallSchema = z.object({
  id: z.string().max(200),
  type: z.literal("function"),
  function: z.object({ name: z.string().max(200), arguments: z.string().max(100_000) }),
});

const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant", "tool"]),
        content: z.string().max(200_000).nullable(),
        name: z.string().max(200).optional(),
        tool_calls: z.array(toolCallSchema).max(50).optional(),
        tool_call_id: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(200),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string().max(200), description: z.string().max(4_000).optional(), parameters: record.optional() }),
      }),
    )
    .max(100)
    .optional(),
  tool_choice: z
    .union([z.enum(["auto", "none", "required"]), z.object({ type: z.literal("function"), function: z.object({ name: z.string() }) })])
    .optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_768).optional(),
  response_format: z
    .union([
      z.object({ type: z.literal("text") }),
      z.object({ type: z.literal("json_object") }),
      z.object({
        type: z.literal("json_schema"),
        json_schema: z.object({ name: z.string().max(200), schema: record, strict: z.boolean().optional() }),
      }),
    ])
    .optional(),
  stream: z.boolean().optional(),
});

export const aiRoutes: RoutePlugin = async (app, { ctx }) => {
  app.post("/api/ai/grid-query", { bodyLimit: AI_BODY_LIMIT }, async (request) =>
    ctx.ai.gridQuery(parseInput(gridQuerySchema, request.body) as GridQueryRequestDTO),
  );

  app.post("/api/ai/chat", { bodyLimit: AI_BODY_LIMIT }, async (request, reply) => {
    const body = parseInput(chatSchema, request.body) as ChatRequestDTO;
    // Stop generating when the client goes away.
    const controller = new AbortController();
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) controller.abort();
    });
    return ctx.ai.chatProxy(body, controller.signal);
  });
};
