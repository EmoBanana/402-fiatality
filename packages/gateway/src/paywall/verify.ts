/**
 * PAYMENT-SIGNATURE verification (SPEC §5.3 step 4), in order: shape -> scheme/network -> tab -> tab status ->
 * agent key + Ed25519 signature -> seller/price -> freshness -> request hash. The sequence and policy checks
 * run inside the reserve transaction (ledger.ts) so they see a consistent ledger.
 * Synchronous on purpose: nothing can interleave between these checks and the reservation.
 */
import { DEFAULT_POLICY, type PaymentPayload, type PaymentRequiredReason, type Policy, type Voucher } from "@p402/shared";
import { decodeX402Header, requestHash, verifyVoucher } from "@p402/shared/node";
import { z } from "zod";
import type { AppContext } from "../context";
import { parseJson, stmt } from "../db/db";
import type { EndpointRow, TabRow } from "../db/dto";
import { MAX_VOUCHER_TTL_SEC, paypalNetwork } from "./requirements";

/** Clock skew tolerated on `iat` (agents sign with their own wall clock). */
export const IAT_SKEW_SEC = 30;

export interface Rejection {
  reason: PaymentRequiredReason;
  message: string;
  expectedSeq?: number;
  expectedCumulative?: string;
  retryAfterSec?: number;
}

export interface VerifiedPayment {
  voucher: Voucher;
  tab: TabRow;
  policy: Policy;
  priceMicros: number;
  cumulativeMicros: number;
}

const decimalString = z.string().regex(/^(0|[1-9]\d{0,15})$/, "must be a non-negative integer string");

/** Strict: the signature covers exactly these members, so unknown members are rejected rather than ignored. */
const voucherSchema = z.strictObject({
  v: z.literal(1),
  tab: z.string().min(1).max(64),
  seller: z.string().min(1).max(64),
  seq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  price: decimalString,
  cumulative: decimalString,
  reqHash: z.string().min(1).max(128),
  agent: z.string().min(1).max(64).optional(),
  task: z.string().min(1).max(128).optional(),
  iat: z.number().int().min(0),
  exp: z.number().int().min(0),
  nonce: z.string().min(1).max(64),
});

const payloadSchema = z.object({
  x402Version: z.literal(2),
  resource: z.object({ url: z.string().max(4096) }),
  accepted: z.looseObject({ scheme: z.string(), network: z.string() }),
  payload: z.object({ voucher: z.record(z.string(), z.unknown()), sig: z.string().min(1).max(256) }),
});

/** A check's outcome: the value, or why the gateway answers 402. */
export type Checked<T> = { ok: true; value: T } | { ok: false; rejection: Rejection };

export function reject(reason: PaymentRequiredReason, message: string, more: Partial<Rejection> = {}): { ok: false; rejection: Rejection } {
  return { ok: false, rejection: { reason, message, ...more } };
}

export interface DecodedPayment {
  payload: PaymentPayload;
  voucher: Voucher;
}

/** base64 JSON -> PaymentPayload with a well-formed voucher for our scheme and network. */
export function decodePaymentHeader(ctx: AppContext, header: string): Checked<DecodedPayment> {
  const raw = decodeX402Header<unknown>(header);
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return reject("invalid_voucher", "PAYMENT-SIGNATURE is not a base64 JSON x402 PaymentPayload.");
  const { accepted, payload } = parsed.data;
  if (accepted.scheme !== "batch-settlement") return reject("invalid_voucher", `Unsupported scheme "${accepted.scheme}".`);
  if (accepted.network !== paypalNetwork(ctx)) {
    return reject("invalid_voucher", `Wrong network "${accepted.network}": this gateway settles on ${paypalNetwork(ctx)}.`);
  }
  const voucher = voucherSchema.safeParse(payload.voucher);
  if (!voucher.success) {
    const issue = voucher.error.issues[0];
    return reject("invalid_voucher", `Malformed voucher${issue ? ` (${issue.path.join(".") || "voucher"}: ${issue.message})` : ""}.`);
  }
  return { ok: true, value: { payload: parsed.data as unknown as PaymentPayload, voucher: voucher.data } };
}

export interface VerifyArgs {
  sellerId: string;
  endpoint: EndpointRow;
  method: string;
  pathWithQuery: string;
  rawBody: Buffer;
  /** Seconds a paused tab's agent should wait before retrying. */
  retryAfterSec: (tabId: string) => number;
}

export function verifyPayment(ctx: AppContext, decoded: DecodedPayment, args: VerifyArgs): Checked<VerifiedPayment> {
  const { voucher, payload } = decoded;

  const tab = stmt(ctx.db, "SELECT * FROM tabs WHERE id = ?").get(voucher.tab) as TabRow | undefined;
  if (!tab) return reject("tab_not_found", `Tab ${voucher.tab} does not exist.`);
  if (tab.status === "paused") {
    const retryAfterSec = args.retryAfterSec(tab.id);
    return reject("tab_paused", "This tab is paused while its spending is reviewed.", { retryAfterSec });
  }
  if (tab.status === "frozen") return reject("tab_frozen", "This tab is frozen: its agents can't spend any more.");
  if (tab.status !== "active") return reject("tab_not_active", `This tab is ${tab.status.replace("_", " ")}, not active.`);

  if (!voucher.agent) return reject("invalid_signature", "The voucher names no agent, so its signature can't be checked.");
  const key = stmt(ctx.db, "SELECT public_key FROM agent_keys WHERE tab_id = ? AND agent_id = ?").get(tab.id, voucher.agent) as
    | { public_key: string }
    | undefined;
  if (!key) return reject("invalid_signature", `Agent ${voucher.agent} has no key registered on this tab.`);
  // Verify over the voucher exactly as received (strict schema: nothing was added or dropped).
  if (!verifyVoucher({ voucher: payload.payload.voucher, sig: payload.payload.sig }, key.public_key)) {
    return reject("invalid_signature", "The voucher signature does not verify with the agent's registered key.");
  }

  if (voucher.seller !== args.sellerId || voucher.price !== String(args.endpoint.price_micros)) {
    // Nothing was recorded: tell the agent what this seller's next voucher must carry at the right price.
    const channel = stmt(ctx.db, "SELECT last_seq, last_cumulative_micros FROM channels WHERE tab_id = ? AND seller_id = ?").get(
      tab.id,
      args.sellerId,
    ) as { last_seq: number; last_cumulative_micros: number } | undefined;
    const expected = {
      expectedSeq: (channel?.last_seq ?? 0) + 1,
      expectedCumulative: String((channel?.last_cumulative_micros ?? 0) + args.endpoint.price_micros),
    };
    return voucher.seller !== args.sellerId
      ? reject("amount_mismatch", `The voucher pays ${voucher.seller}, but this resource is sold by ${args.sellerId}.`, expected)
      : reject("amount_mismatch", `This call costs ${args.endpoint.price_micros} µUSD, the voucher says ${voucher.price}.`, expected);
  }

  // Wall-clock time: agents sign with real time while the demo clock may be fast-forwarded.
  const realNowSec = Math.floor((ctx.clock.now() - ctx.clock.offsetMs()) / 1000);
  if (voucher.iat > realNowSec + IAT_SKEW_SEC) return reject("voucher_expired", "The voucher is issued in the future.");
  if (voucher.exp <= realNowSec) return reject("voucher_expired", "The voucher has expired.");
  if (voucher.exp <= voucher.iat || voucher.exp - voucher.iat > MAX_VOUCHER_TTL_SEC) {
    return reject("voucher_expired", `A voucher may live at most ${MAX_VOUCHER_TTL_SEC} seconds.`);
  }

  if (voucher.reqHash !== requestHash(args.method, args.pathWithQuery, args.rawBody)) {
    return reject("invalid_voucher", "The voucher was signed for a different request (method, path, query or body).");
  }

  const priceMicros = Number(voucher.price);
  const cumulativeMicros = Number(voucher.cumulative);
  if (!Number.isSafeInteger(cumulativeMicros)) return reject("invalid_voucher", "The voucher's cumulative amount is too large.");
  return {
    ok: true,
    value: { voucher, tab, policy: parseJson<Policy>(tab.policy, DEFAULT_POLICY), priceMicros, cumulativeMicros },
  };
}
