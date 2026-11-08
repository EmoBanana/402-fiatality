/** Structured output shared by every provider: send a JSON Schema, validate with zod, retry once. */
import type { LlmCallOptions, LlmMessage } from "@p402/gateway/context";
import { z } from "zod";
import { truncate } from "../util/text";
import { LlmError } from "./errors";
import { type JsonSchema, toJsonSchema } from "./schema";

export interface StructuredFormat {
  /** OpenAI json_schema name (letters, digits, _ and -). */
  name: string;
  schema: JsonSchema;
}

export interface Completion {
  content: string;
  /** The model hit its token limit before finishing. */
  truncated: boolean;
}

/** One provider round trip constrained to `format`. */
export type JsonSender = (messages: LlmMessage[], format: StructuredFormat, opts: LlmCallOptions) => Promise<Completion>;

export type JsonParse = { ok: true; value: unknown } | { ok: false; error: string };

/** Parse a model reply as JSON, tolerating code fences and prose around one object or array. */
export function parseJsonReply(text: string): JsonParse {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "the reply was empty" };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidates = [trimmed, fenced?.[1]?.trim(), sliceBetween(trimmed, "{", "}"), sliceBetween(trimmed, "[", "]")];
  let firstError = "";
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (err) {
      firstError ||= err instanceof Error ? err.message : String(err);
    }
  }
  return { ok: false, error: `not valid JSON (${firstError})` };
}

/** Readable zod issues, capped so the retry prompt stays small. */
export function describeIssues(error: z.ZodError, max = 6): string {
  return error.issues
    .slice(0, max)
    .map((issue) => `- ${issue.path.length ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join("\n");
}

/**
 * Ask for JSON matching `schema`. On a parse or validation failure, retry once with the faulty reply and the
 * error appended; a second failure throws LlmError("invalid_output").
 */
export async function structuredCall<T>(
  send: JsonSender,
  messages: LlmMessage[],
  schema: z.ZodType<T>,
  opts: LlmCallOptions = {},
): Promise<T> {
  const format: StructuredFormat = { name: "reply", schema: toJsonSchema(schema) };
  let attempt = messages;
  let problem = "";
  for (let i = 0; i < 2; i++) {
    const reply = await send(attempt, format, opts);
    const parsed = parseJsonReply(reply.content);
    if (parsed.ok) {
      const result = schema.safeParse(parsed.value);
      if (result.success) return result.data;
      problem = `The JSON did not match the required format:\n${describeIssues(result.error)}`;
    } else {
      problem = reply.truncated
        ? "The reply was cut off before the JSON ended. Use shorter values."
        : `The reply was ${parsed.error}.`;
    }
    attempt = [
      ...messages,
      { role: "assistant", content: truncate(reply.content, 1_500) || "(empty)" },
      { role: "user", content: `${problem}\nReply again with only the corrected JSON object.` },
    ];
  }
  throw new LlmError("invalid_output", `The model's JSON failed validation twice. ${problem}`);
}

function sliceBetween(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}
