/**
 * JSON Schema helpers for structured output.
 *
 * Zod 4 produces the schema; `forGrammar` trims the keywords that make Ollama's grammar slow or huge
 * (zod's safe-integer bounds, long string lengths, regex patterns). Zod still validates everything after.
 */
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export function toJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  delete json.$schema;
  return json;
}

const DROP_KEYS = new Set([
  "$schema",
  "$id",
  "default",
  "examples",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);

/** A copy of `schema` that constrained decoding handles quickly. Validation still uses the full zod schema. */
export function forGrammar(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forGrammar);
  if (!isRecord(schema)) return schema;
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROP_KEYS.has(key)) continue;
    if ((key === "maxLength" || key === "minLength") && typeof value === "number" && value > 64) continue;
    if (key === "maxItems" && typeof value === "number" && value > 32) continue;
    if (key === "properties" && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forGrammar(v)]));
    } else if (key === "$defs" && isRecord(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, forGrammar(v)]));
    } else {
      out[key] = forGrammar(value);
    }
  }
  return out;
}

/** OpenAI `strict: true` needs every property required and no extra properties, at every level. */
export function isStrictCompatible(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.every(isStrictCompatible);
  if (!isRecord(schema)) return true;
  const props = schema.properties;
  if (isRecord(props)) {
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (schema.additionalProperties !== false) return false;
    if (!Object.keys(props).every((k) => required.includes(k))) return false;
  }
  return Object.entries(schema).every(([key, value]) => key === "enum" || key === "const" || isStrictCompatible(value));
}

/** OpenAI wants `additionalProperties: false` spelled out for strict mode. */
export function closeObjects(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(closeObjects);
  if (!isRecord(schema)) return schema;
  const out: JsonSchema = Object.fromEntries(
    Object.entries(schema).map(([k, v]) => [k, k === "enum" || k === "const" ? v : closeObjects(v)]),
  );
  if (isRecord(out.properties) && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

/**
 * A deterministic, minimal instance of a JSON Schema: first enum member, first non-null union branch,
 * defaults when given, required properties only, `minItems` items. The mock LLM answers with this.
 */
export function sampleFromSchema(schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (!isRecord(schema) || depth > 12) return null;
  if (typeof schema.$ref === "string") return sampleFromSchema(resolveRef(root, schema.$ref), root, depth + 1);
  if ("const" in schema) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const variants = (schema.anyOf ?? schema.oneOf) as unknown[] | undefined;
  if (Array.isArray(variants) && variants.length > 0) {
    const pick = variants.find((v) => !(isRecord(v) && v.type === "null")) ?? variants[0];
    return sampleFromSchema(pick, root, depth + 1);
  }
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.reduce<Record<string, unknown>>((acc, part) => {
      const value = sampleFromSchema(part, root, depth + 1);
      return isRecord(value) ? { ...acc, ...value } : acc;
    }, {});
  }
  const type = Array.isArray(schema.type) ? (schema.type.find((t) => t !== "null") ?? "null") : schema.type;
  switch (type ?? (isRecord(schema.properties) ? "object" : undefined)) {
    case "object": {
      const props = isRecord(schema.properties) ? schema.properties : {};
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      return Object.fromEntries(required.filter((k) => k in props).map((k) => [k, sampleFromSchema(props[k], root, depth + 1)]));
    }
    case "array": {
      const n = typeof schema.minItems === "number" ? schema.minItems : 0;
      return Array.from({ length: n }, () => sampleFromSchema(schema.items, root, depth + 1));
    }
    case "string": {
      if (schema.format === "date-time") return new Date(0).toISOString();
      return "x".repeat(typeof schema.minLength === "number" ? schema.minLength : 0);
    }
    case "integer":
    case "number": {
      // 0 when allowed (zod's int() adds safe-integer bounds), else the nearest bound.
      const min = typeof schema.minimum === "number" ? schema.minimum : undefined;
      const exMin = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : undefined;
      const max = typeof schema.maximum === "number" ? schema.maximum : undefined;
      if (min !== undefined && min > 0) return min;
      if (exMin !== undefined && exMin >= 0) return type === "integer" ? Math.floor(exMin) + 1 : exMin + 0.5;
      if (max !== undefined && max < 0) return max;
      return 0;
    }
    case "boolean":
      return false;
    default:
      return null;
  }
}

function resolveRef(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!isRecord(node)) return undefined;
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
