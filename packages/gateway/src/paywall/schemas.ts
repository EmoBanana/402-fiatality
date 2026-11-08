/** Endpoint response schemas (JSON Schema, ajv): compiled once per distinct schema and cached. */
import Ajv, { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

const ajv = new Ajv({ allErrors: false, strict: false, validateSchema: true });
addFormats(ajv);

const cache = new Map<string, ValidateFunction>();
const MAX_CACHED = 500;

/** Compile (or reuse) a validator. Throws when the schema itself is invalid. */
export function compileResponseSchema(schema: Record<string, unknown> | string): ValidateFunction {
  const key = typeof schema === "string" ? schema : JSON.stringify(schema);
  let validate = cache.get(key);
  if (!validate) {
    validate = ajv.compile(typeof schema === "string" ? (JSON.parse(schema) as Record<string, unknown>) : schema);
    if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
    cache.set(key, validate);
  }
  return validate;
}

/** Human-readable reason a value failed, for logs and excerpts. */
export function describeSchemaErrors(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { separator: "; " });
}
