/**
 * The voucher ledger. `reserveVoucher` checks the channel sequence and the tab's policy, then advances the
 * channel and inserts the voucher as `pending`, all in one transaction (SPEC §5.3 steps 4-5). Pending vouchers
 * count toward the hold, the daily cap and the rate limit (so concurrent calls can't overspend) but are never
 * billable, returned or emitted. `finalizeVoucher` records the quality guard's verdict.
 */
import { MICROS_PER_CENT, newId, sellerAllowed, type VoidReason, type VoucherDTO } from "@p402/shared";
import { MINUTE_MS, startOfUtcDay } from "../clock";
import type { AppContext } from "../context";
import { stmt, tx } from "../db/db";
import { voucherDTO, type ChannelRow, type EndpointRow, type VoucherRow } from "../db/dto";
import { reject, type Checked, type VerifiedPayment } from "./verify";

export const REQUEST_EXCERPT_CHARS = 500;
export const RESPONSE_EXCERPT_BYTES = 2048;

export interface ReserveArgs {
  sellerId: string;
  endpoint: EndpointRow;
  method: string;
  pathWithQuery: string;
  rawBody: Buffer;
  /** The PAYMENT-SIGNATURE header exactly as received. */
  signatureHeader: string;
}

export interface Reservation {
  voucherId: string;
  createdAt: number;
}

function requestExcerpt(method: string, pathWithQuery: string, body: Buffer): string {
  const head = `${method} ${pathWithQuery}`;
  if (body.length === 0) return head;
  return `${head}\n${body.subarray(0, REQUEST_EXCERPT_CHARS * 4).toString("utf8").slice(0, REQUEST_EXCERPT_CHARS)}`;
}

export function reserveVoucher(ctx: AppContext, v: VerifiedPayment, args: ReserveArgs): Checked<Reservation> {
  const { voucher, tab, policy, priceMicros, cumulativeMicros } = v;
  const db = ctx.db;
  try {
    return tx(db, (): Checked<Reservation> => {
      const channel = stmt(db, "SELECT * FROM channels WHERE tab_id = ? AND seller_id = ?").get(tab.id, args.sellerId) as
        | ChannelRow
        | undefined;
      const expectedSeq = (channel?.last_seq ?? 0) + 1;
      const expectedCumulative = (channel?.last_cumulative_micros ?? 0) + priceMicros;
      if (voucher.seq !== expectedSeq || cumulativeMicros !== expectedCumulative) {
        return reject(
          "stale_sequence",
          `Expected seq ${expectedSeq} with cumulative ${expectedCumulative}, got seq ${voucher.seq} with ${cumulativeMicros}.`,
          { expectedSeq, expectedCumulative: String(expectedCumulative) },
        );
      }

      if (!sellerAllowed(policy, args.sellerId)) {
        return reject("seller_not_allowed", `This tab's policy does not allow paying ${args.sellerId}.`);
      }
      if (priceMicros > policy.perCallMaxMicros) {
        return reject("price_above_limit", `This call costs more than the tab's per-call limit (${policy.perCallMaxMicros} µUSD).`);
      }
      const now = ctx.clock.now();
      const usage = stmt(
        db,
        `SELECT COALESCE(SUM(CASE WHEN status != 'voided' THEN price_micros END), 0) AS committed,
                COALESCE(SUM(CASE WHEN status != 'voided' AND created_at >= ? THEN price_micros END), 0) AS today,
                COALESCE(SUM(created_at > ?), 0) AS last_minute,
                MIN(CASE WHEN created_at > ? THEN created_at END) AS oldest_in_minute
           FROM vouchers WHERE tab_id = ?`,
      ).get(startOfUtcDay(now), now - MINUTE_MS, now - MINUTE_MS, tab.id) as {
        committed: number;
        today: number;
        last_minute: number;
        oldest_in_minute: number | null;
      };
      if (usage.today + priceMicros > policy.dailyCapMicros) {
        return reject("daily_cap_reached", "This tab has reached today's spending cap.");
      }
      if (usage.committed + tab.carry_in_micros + priceMicros > tab.hold_cents * MICROS_PER_CENT) {
        return reject("hold_exhausted", "This call would exceed the tab's PayPal hold.");
      }
      if (usage.last_minute >= policy.maxCallsPerMinute) {
        const retryAfterSec = Math.max(1, Math.ceil(((usage.oldest_in_minute ?? now) + MINUTE_MS - now) / 1000));
        return reject("rate_limited", `This tab allows ${policy.maxCallsPerMinute} calls per minute.`, { retryAfterSec });
      }

      stmt(
        db,
        `INSERT INTO channels (tab_id, seller_id, last_seq, last_cumulative_micros) VALUES (?, ?, ?, ?)
         ON CONFLICT (tab_id, seller_id) DO UPDATE SET last_seq = excluded.last_seq, last_cumulative_micros = excluded.last_cumulative_micros`,
      ).run(tab.id, args.sellerId, voucher.seq, cumulativeMicros);
      const voucherId = newId("vch");
      stmt(
        db,
        `INSERT INTO vouchers (id, tab_id, seller_id, endpoint_id, seq, price_micros, cumulative_micros, req_hash, method, path,
                               agent_id, task_id, status, request_excerpt, signature, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      ).run(
        voucherId,
        tab.id,
        args.sellerId,
        args.endpoint.id,
        voucher.seq,
        priceMicros,
        cumulativeMicros,
        voucher.reqHash,
        args.method,
        args.pathWithQuery,
        voucher.agent ?? null,
        voucher.task ?? null,
        requestExcerpt(args.method, args.pathWithQuery, args.rawBody),
        args.signatureHeader,
        now,
      );
      return { ok: true, value: { voucherId, createdAt: now } };
    });
  } catch (err) {
    // UNIQUE (tab_id, seller_id, seq) is the backstop against a concurrent writer on the same database.
    const code = (err as { code?: string }).code;
    if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
      return reject("stale_sequence", "This sequence number was already used.");
    }
    throw err;
  }
}

export interface VoucherOutcome {
  status: "accepted" | "voided";
  voidReason: VoidReason | null;
  httpStatus: number | null;
  latencyMs: number;
  responseBytes: number;
  responseExcerpt: string | null;
}

/** Record the quality guard's verdict on a pending voucher and return it as a DTO. */
export function finalizeVoucher(ctx: AppContext, voucherId: string, outcome: VoucherOutcome): VoucherDTO {
  stmt(
    ctx.db,
    `UPDATE vouchers SET status = ?, void_reason = ?, http_status = ?, latency_ms = ?, response_bytes = ?, response_excerpt = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(
    outcome.status,
    outcome.voidReason,
    outcome.httpStatus,
    outcome.latencyMs,
    outcome.responseBytes,
    outcome.responseExcerpt,
    voucherId,
  );
  return voucherDTO(stmt(ctx.db, "SELECT * FROM vouchers WHERE id = ?").get(voucherId) as VoucherRow);
}

export function responseExcerpt(body: Buffer): string | null {
  if (body.length === 0) return null;
  return body.subarray(0, RESPONSE_EXCERPT_BYTES).toString("utf8");
}

/**
 * Pending vouchers left behind by a crash were never judged: void them (the agent can't have received the
 * response through us). Called once at startup.
 */
export function recoverPendingVouchers(ctx: AppContext): number {
  return stmt(
    ctx.db,
    "UPDATE vouchers SET status = 'voided', void_reason = 'upstream_unreachable', response_excerpt = 'gateway restarted mid-call' WHERE status = 'pending'",
  ).run().changes;
}
