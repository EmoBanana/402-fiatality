/**
 * PayPal network binding for the x402 v2 `batch-settlement` scheme.
 *
 * Wire format follows x402 v2: the server answers 402 with a base64 JSON
 * `PAYMENT-REQUIRED` header, the client retries with a base64 JSON
 * `PAYMENT-SIGNATURE` header, and the server returns `PAYMENT-RESPONSE`.
 * Amounts are strings in base units of 6 decimals (micro-dollars).
 * See docs/BINDING.md for the full binding.
 */
import type { VoidRules } from "./voidRules";

export const X402_VERSION = 2 as const;
export const X402_SCHEME = "batch-settlement" as const;

export const X402_HEADERS = {
  required: "PAYMENT-REQUIRED",
  signature: "PAYMENT-SIGNATURE",
  response: "PAYMENT-RESPONSE",
} as const;

export type PaypalNetwork = "paypal:sandbox" | "paypal:live" | "paypal:mock";

/** Why the gateway answered 402 instead of serving the resource. */
export type PaymentRequiredReason =
  | "payment_required"
  | "tab_not_found"
  | "tab_not_active"
  | "tab_paused"
  | "tab_frozen"
  | "hold_exhausted"
  | "daily_cap_reached"
  | "price_above_limit"
  | "seller_not_allowed"
  | "rate_limited"
  | "invalid_signature"
  | "invalid_voucher"
  | "stale_sequence"
  | "amount_mismatch"
  | "voucher_expired";

export interface PaymentRequirements {
  scheme: typeof X402_SCHEME;
  network: PaypalNetwork;
  /** ISO currency; amounts below are in 6-decimal base units of it. */
  asset: "USD";
  /** Price of this call in micro-dollars, e.g. "5000" = $0.005. */
  amount: string;
  /** Seller id that is paid for this resource. */
  payTo: string;
  maxTimeoutSeconds: number;
  extra: {
    decimals: 6;
    endpointId: string;
    /** Where a company opens a tab (PayPal hold) to pay with this scheme. */
    tabEndpoint: string;
    catalogUrl: string;
    voidRules: VoidRules;
    reason?: PaymentRequiredReason;
    message?: string;
    /** For stale_sequence / amount_mismatch: what the gateway expects next. */
    expectedSeq?: number;
    expectedCumulative?: string;
    retryAfterSec?: number;
  };
}

export interface PaymentRequired {
  x402Version: typeof X402_VERSION;
  error?: string;
  resource: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirements[];
}

/** One IOU. `cumulative` is the running total owed to this seller on this tab. */
export interface Voucher {
  v: 1;
  tab: string;
  seller: string;
  /** Strictly increasing per (tab, seller), starting at 1. */
  seq: number;
  /** Price of this call in micro-dollars (decimal string). */
  price: string;
  /** Running total for (tab, seller) including this call (decimal string). */
  cumulative: string;
  /** base64url SHA-256 of the canonical request (method, path+query, body hash). */
  reqHash: string;
  agent?: string;
  /** Optional task id for cost attribution. */
  task?: string;
  /** Issued-at and expiry, unix seconds. */
  iat: number;
  exp: number;
  /** 16 random bytes, base64url. */
  nonce: string;
}

export interface SignedVoucher {
  voucher: Voucher;
  /** Ed25519 signature over canonicalJson(voucher), base64url. */
  sig: string;
}

export interface PaymentPayload {
  x402Version: typeof X402_VERSION;
  resource: { url: string };
  accepted: PaymentRequirements;
  payload: SignedVoucher;
}

/** Sent back in PAYMENT-RESPONSE after the call is served. */
export interface SettlementResponse {
  success: boolean;
  scheme: typeof X402_SCHEME;
  network: PaypalNetwork;
  /** Commitment identifier (the voucher id in the ledger). */
  transaction: string;
  status: "accepted" | "voided";
  /** Billable amount for this call in micro-dollars ("0" when voided). */
  amount: string;
  cumulative: string;
  reason?: string;
}
