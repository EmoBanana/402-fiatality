import { z } from "zod";

/**
 * Pre-agreed rules for which responses are NOT billable. Each seller declares these
 * in its listing, so a void is a contract term rather than a judgment call.
 */
export interface VoidRules {
  /** Void when the seller answers with a 5xx status. */
  on5xx: boolean;
  /** Void when the seller answers with a 4xx status (except 402). */
  on4xx: boolean;
  /** Void when the seller does not answer within this many milliseconds. */
  timeoutMs: number;
  /** When false, empty bodies, [] / {} and empty result arrays are not billable. */
  emptyIsBillable: boolean;
  /** Dot paths to result arrays that must be non-empty, e.g. ["products"]. */
  emptyResultPaths: string[];
  /** Void when a JSON content-type response does not parse. */
  requireJson: boolean;
}

export const DEFAULT_VOID_RULES: VoidRules = {
  on5xx: true,
  on4xx: true,
  timeoutMs: 8_000,
  emptyIsBillable: false,
  emptyResultPaths: [],
  requireJson: true,
};

export const voidRulesSchema = z.object({
  on5xx: z.boolean(),
  on4xx: z.boolean(),
  timeoutMs: z.number().int().min(250).max(60_000),
  emptyIsBillable: z.boolean(),
  emptyResultPaths: z.array(z.string().min(1).max(120)).max(10),
  requireJson: z.boolean(),
});

export type VoidReason =
  | "upstream_5xx"
  | "upstream_4xx"
  | "upstream_unreachable"
  | "timeout"
  | "empty_result"
  | "malformed_json"
  | "schema_mismatch"
  | "ai_review";

export const VOID_REASON_LABELS: Record<VoidReason, string> = {
  upstream_5xx: "Seller error (5xx)",
  upstream_4xx: "Seller rejected request (4xx)",
  upstream_unreachable: "Seller unreachable",
  timeout: "Timed out",
  empty_result: "Empty result",
  malformed_json: "Malformed JSON",
  schema_mismatch: "Response didn't match schema",
  ai_review: "Voided by AI review",
};
