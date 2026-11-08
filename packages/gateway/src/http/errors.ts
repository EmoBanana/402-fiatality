/**
 * Every error leaves the gateway as ApiErrorDTO `{ error, message, details? }`. Services throw AppError;
 * zod errors become 400 `invalid_request`; Fastify's own 4xx errors keep their status; anything else is a
 * 500 `internal_error` with no internals in the body (the full error goes to the log).
 */
import type { ApiErrorDTO } from "@p402/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../context";

export const notFound = (what: string, id?: string) =>
  new AppError(404, "not_found", id ? `${what} ${id} was not found.` : `${what} was not found.`);

export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

export const badRequest = (message: string, details?: unknown) => new AppError(400, "invalid_request", message, details);

/** Validate untrusted input. Throws ZodError, which the error handler renders as 400 `invalid_request`. */
export function parseInput<T>(schema: z.ZodType<T>, data: unknown): T {
  return schema.parse(data);
}

interface IssueLike {
  path: PropertyKey[];
  message: string;
  code?: string;
}

function isZodError(err: unknown): err is { issues: IssueLike[] } {
  return err instanceof z.ZodError || (err instanceof Error && err.name === "ZodError" && Array.isArray((err as { issues?: unknown }).issues));
}

const FASTIFY_CODES: Record<number, string> = {
  400: "invalid_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  406: "not_acceptable",
  408: "request_timeout",
  413: "payload_too_large",
  415: "unsupported_media_type",
  429: "rate_limited",
};

export function toApiError(err: unknown): { status: number; body: ApiErrorDTO } {
  if (err instanceof AppError) {
    const body: ApiErrorDTO = { error: err.code, message: err.message };
    if (err.details !== undefined) body.details = err.details;
    return { status: err.status, body };
  }
  if (isZodError(err)) {
    const issues = err.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message, code: i.code }));
    const summary = issues
      .slice(0, 3)
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join("; ");
    return { status: 400, body: { error: "invalid_request", message: `Invalid request: ${summary}`, details: issues } };
  }
  const e = err as { statusCode?: unknown; validation?: unknown; message?: unknown } | null;
  if (e && e.validation) {
    return { status: 400, body: { error: "invalid_request", message: String(e.message ?? "Invalid request") } };
  }
  if (e && typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) {
    const status = e.statusCode;
    return { status, body: { error: FASTIFY_CODES[status] ?? "bad_request", message: String(e.message ?? "Bad request") } };
  }
  return { status: 500, body: { error: "internal_error", message: "Something went wrong on the gateway." } };
}

export function errorHandler(err: unknown, request: FastifyRequest, reply: FastifyReply): void {
  const { status, body } = toApiError(err);
  if (status >= 500) request.log.error({ err, method: request.method, url: request.routeOptions.url }, "request failed");
  void reply.code(status).type("application/json; charset=utf-8").send(body);
}
