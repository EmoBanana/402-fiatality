/**
 * Typed PayPal failures. Every PaypalClient failure is a PaypalError: AppError 502 `paypal_error` whose
 * details carry PayPal's error `name`, `debug_id` and `issues`, so the console can show them and PayPal
 * support can trace them.
 *
 * Never attach the raw SDK/axios error (not even as `cause`): it holds the outgoing request, including the
 * bearer token, and the server's error handler logs whatever it is given.
 */
import { AppError } from "../context";

export interface PaypalIssue {
  issue: string;
  description?: string;
  field?: string;
}

/** `ApiErrorDTO.details` of a PaypalError. */
export interface PaypalErrorDetails {
  name: string;
  debug_id: string | null;
  issues: PaypalIssue[];
}

export interface PaypalErrorInit {
  /** What we were doing, e.g. "capture authorization". */
  operation: string;
  /** PayPal's error name (UNPROCESSABLE_ENTITY, INVALID_REQUEST, ...) or ours (NETWORK_ERROR, TIMEOUT, ...). */
  paypalName: string;
  message: string;
  debugId?: string | null;
  issues?: PaypalIssue[];
  /** HTTP status PayPal answered with; null for network failures, timeouts and unusable responses. */
  httpStatus?: number | null;
}

export class PaypalError extends AppError {
  override name = "PaypalError";
  readonly operation: string;
  readonly paypalName: string;
  readonly debugId: string | null;
  readonly issues: PaypalIssue[];
  readonly httpStatus: number | null;

  constructor(init: PaypalErrorInit) {
    const issues = init.issues ?? [];
    const debugId = init.debugId ?? null;
    const details: PaypalErrorDetails = { name: init.paypalName, debug_id: debugId, issues };
    super(502, "paypal_error", describe(init.operation, init.paypalName, init.message, issues, debugId), details);
    this.operation = init.operation;
    this.paypalName = init.paypalName;
    this.debugId = debugId;
    this.issues = issues;
    this.httpStatus = init.httpStatus ?? null;
  }

  /** True when PayPal reported any of these issue codes (or used one of them as the error name). */
  hasIssue(...codes: string[]): boolean {
    return codes.includes(this.paypalName) || this.issues.some((i) => codes.includes(i.issue));
  }

  /** Safe, structured fields for logs. */
  toLog(): Record<string, unknown> {
    return { operation: this.operation, name: this.paypalName, debugId: this.debugId, status: this.httpStatus, issues: this.issues };
  }
}

function describe(operation: string, name: string, message: string, issues: PaypalIssue[], debugId: string | null): string {
  const first = issues[0];
  const what = first ? `${first.issue}${first.description ? `: ${first.description}` : ""}` : `${name}${message ? `: ${message}` : ""}`;
  return `PayPal ${operation} failed (${what})${debugId ? ` [debug_id ${debugId}]` : ""}`;
}

/** PayPal's REST error body (Orders v2, Payments v2, Payouts v1) or its OAuth error body. */
interface PaypalErrorBody {
  name?: unknown;
  message?: unknown;
  debug_id?: unknown;
  details?: unknown;
  error?: unknown;
  error_description?: unknown;
}

const text = (value: unknown, max = 300): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

function issuesOf(details: unknown): PaypalIssue[] {
  if (!Array.isArray(details)) return [];
  return details.slice(0, 10).flatMap((d) => {
    if (!d || typeof d !== "object") return [];
    const row = d as Record<string, unknown>;
    const issue = text(row.issue, 120) ?? text(row.name, 120);
    if (!issue) return [];
    const out: PaypalIssue = { issue };
    const description = text(row.description);
    const field = text(row.field, 200);
    if (description) out.description = description;
    if (field) out.field = field;
    return [out];
  });
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return text((headers as Headers).get(name), 120);
  const record = headers as Record<string, unknown>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  return key ? text(record[key], 120) : undefined;
}

/** Build a PaypalError from an HTTP error response (REST call or SDK ApiError). */
export function paypalErrorFromResponse(
  operation: string,
  status: number,
  body: unknown,
  headers?: unknown,
): PaypalError {
  const b = (body && typeof body === "object" ? body : {}) as PaypalErrorBody;
  const oauthError = text(b.error, 120);
  const paypalName = text(b.name, 120) ?? oauthError ?? `HTTP_${status}`;
  const message = text(b.message) ?? text(b.error_description) ?? "";
  const debugId = text(b.debug_id, 120) ?? headerValue(headers, "paypal-debug-id") ?? null;
  return new PaypalError({ operation, paypalName, message, debugId, issues: issuesOf(b.details), httpStatus: status });
}

/**
 * Map anything a PayPal call threw to a PaypalError. Handles the Server SDK's ApiError (statusCode + parsed
 * `result`), its timeouts and response-validation errors, fetch failures, and our own PaypalErrors.
 */
export function toPaypalError(err: unknown, operation: string): PaypalError {
  if (err instanceof PaypalError) return err;
  if (err && typeof err === "object" && typeof (err as { statusCode?: unknown }).statusCode === "number") {
    const e = err as { statusCode: number; result?: unknown; headers?: unknown; body?: unknown };
    let body = e.result;
    if (body === undefined && typeof e.body === "string") {
      try {
        body = JSON.parse(e.body);
      } catch {
        body = undefined;
      }
    }
    return paypalErrorFromResponse(operation, e.statusCode, body, e.headers);
  }
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /timeout/i.test(message)) {
    return new PaypalError({ operation, paypalName: "TIMEOUT", message: "PayPal did not answer in time" });
  }
  if (name === "ResponseValidationError") {
    return new PaypalError({ operation, paypalName: "INVALID_RESPONSE", message: "PayPal's response did not match the expected shape" });
  }
  // Only the message: never the error object (axios errors carry the request config and headers).
  return new PaypalError({ operation, paypalName: "NETWORK_ERROR", message: message.slice(0, 200) });
}
