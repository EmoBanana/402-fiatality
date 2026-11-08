/**
 * Quality guard (SPEC §5.3 step 7): decides whether a forwarded call is billable, by the seller's own published
 * void rules. Pure, so every rule is unit-tested in isolation.
 */
import type { VoidReason, VoidRules } from "@p402/shared";
import type { ForwardResult } from "./proxy";
import { compileResponseSchema, describeSchemaErrors } from "./schemas";

export interface Judgement {
  status: "accepted" | "voided";
  voidReason: VoidReason | null;
  /** Why, in a few words (logs, excerpts). */
  detail?: string;
}

const ACCEPTED: Judgement = { status: "accepted", voidReason: null };

const voided = (voidReason: VoidReason, detail?: string): Judgement => ({ status: "voided", voidReason, detail });

export function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType === "text/json" || mediaType.endsWith("+json");
}

type Parsed = { ok: true; value: unknown } | { ok: false };

function parseJson(text: string): Parsed {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Value at a dot path ("products", "data.items", "results.0.offers"); undefined when absent. */
export function valueAtPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isEmptyValue(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value as object).length === 0;
}

export function judgeResponse(result: ForwardResult, rules: VoidRules, responseSchema: string | null): Judgement {
  if (result.kind === "timeout") return voided("timeout", `no response within ${rules.timeoutMs} ms`);
  if (result.kind === "unreachable") return voided("upstream_unreachable", result.detail);
  if (result.kind === "too_large") return voided("upstream_unreachable", "response larger than 2 MB");

  const { status, contentType, body } = result;
  if (status >= 500 && rules.on5xx) return voided("upstream_5xx", `HTTP ${status}`);
  if (status >= 400 && status < 500 && status !== 402 && rules.on4xx) return voided("upstream_4xx", `HTTP ${status}`);

  const text = body.toString("utf8");
  const trimmed = text.trim();
  const json = isJsonContentType(contentType);
  // No content-type at all: still look inside for empty results, but don't demand valid JSON.
  const parsed: Parsed | null = json || contentType === null ? parseJson(text) : null;
  // A zero-length body is an empty result, not malformed JSON.
  if (json && trimmed !== "" && parsed && !parsed.ok && rules.requireJson) return voided("malformed_json", "JSON response does not parse");

  if (!rules.emptyIsBillable) {
    if (trimmed === "") return voided("empty_result", "empty body");
    if (parsed?.ok) {
      if (isEmptyValue(parsed.value)) return voided("empty_result", `body is ${trimmed.slice(0, 8)}`);
      for (const path of rules.emptyResultPaths) {
        const value = valueAtPath(parsed.value, path);
        if (Array.isArray(value) && value.length === 0) return voided("empty_result", `${path} is empty`);
      }
    } else if (!json && (trimmed === "[]" || trimmed === "{}" || trimmed === "null")) {
      return voided("empty_result", `body is ${trimmed}`);
    }
  }

  if (responseSchema) {
    let validate: ReturnType<typeof compileResponseSchema> | null = null;
    try {
      validate = compileResponseSchema(responseSchema);
    } catch {
      validate = null; // rejected at registration; never void a call because our stored schema is broken
    }
    if (validate) {
      const value = parsed ?? parseJson(text);
      if (!value.ok) return voided("schema_mismatch", "response is not JSON");
      if (!validate(value.value)) return voided("schema_mismatch", describeSchemaErrors(validate));
    }
  }
  return ACCEPTED;
}
