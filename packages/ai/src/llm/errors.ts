/**
 * Errors from the LLM layer. `status` and `code` mirror the gateway's AppError fields so its error handler
 * can render them as ApiErrorDTO without importing this package's classes.
 */
export type LlmErrorCode =
  /** The server could not be reached (Ollama not running, wrong LLM_BASE_URL). */
  | "unreachable"
  /** The configured model is not available (`ollama pull <model>`). */
  | "model_missing"
  /** No answer within the time limit. */
  | "timeout"
  /** The caller cancelled the request. */
  | "aborted"
  /** The server answered with an HTTP error. */
  | "http"
  /** The server answered, but not in the expected shape. */
  | "bad_response"
  /** The model's JSON failed schema validation twice. */
  | "invalid_output";

const STATUS: Record<LlmErrorCode, number> = {
  unreachable: 503,
  model_missing: 503,
  timeout: 504,
  aborted: 499,
  http: 502,
  bad_response: 502,
  invalid_output: 502,
};

export class LlmError extends Error {
  override name = "LlmError";
  readonly status: number;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function isLlmError(err: unknown, code?: LlmErrorCode): err is LlmError {
  return err instanceof LlmError && (code === undefined || err.code === code);
}
