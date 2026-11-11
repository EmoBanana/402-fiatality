/**
 * What the ledger knows about a disputed charge: the dispute jury's trusted facts, and the compact ledger
 * summary sent to PayPal with the seller's evidence. Every billed call's Ed25519 signature is re-verified
 * against the agent keys enrolled on the company's own tab.
 */
import { formatCents, formatUsd, type PaymentPayload } from "@p402/shared";
import { decodeX402Header, verifyVoucher } from "@p402/shared/node";
import type { DisputeReviewInput } from "../context";
import { type Db, stmt } from "../db/db";
import { type DisputeRow, type SettlementRow, tabTotals, type TabRow } from "../db/dto";
import { voidStats } from "../settlement/store";
import type { DisputeContext } from "./store";

/** More than any $50 tab can hold at the demo's cheapest price ($0.002 a call). */
const MAX_VERIFIED = 30_000;
const SAMPLE_SIZE = 3;

export interface SignatureFacts {
  billedCalls: number;
  verified: number;
  enrolledKeys: number;
  agentIds: string[];
  samples: Array<{ voucherId: string; requestHash: string; agentId: string | null }>;
}

/**
 * Re-verify the billed calls of a settlement: the voucher in each stored PAYMENT-SIGNATURE header must be for this
 * tab and this request hash, signed by the key its agent enrolled on the tab.
 */
export function verifySignatures(db: Db, settlementId: string, tabId: string): SignatureFacts {
  const keys = new Map(
    (stmt(db, "SELECT agent_id, public_key FROM agent_keys WHERE tab_id = ?").all(tabId) as Array<{ agent_id: string; public_key: string }>).map((k) => [
      k.agent_id,
      k.public_key,
    ]),
  );
  const rows = stmt(
    db,
    "SELECT id, req_hash, agent_id, signature FROM vouchers WHERE settlement_id = ? AND status = 'accepted' ORDER BY created_at, rowid LIMIT ?",
  ).all(settlementId, MAX_VERIFIED) as Array<{ id: string; req_hash: string; agent_id: string | null; signature: string }>;
  let verified = 0;
  const agents = new Set<string>();
  for (const row of rows) {
    const signed = decodeX402Header<PaymentPayload>(row.signature)?.payload;
    const voucher = signed?.voucher;
    const key = voucher?.agent ? keys.get(voucher.agent) : undefined;
    if (!signed || !voucher || !key || voucher.tab !== tabId || voucher.reqHash !== row.req_hash) continue;
    if (verifyVoucher(signed, key)) {
      verified++;
      agents.add(voucher.agent as string);
    }
  }
  return {
    billedCalls: rows.length,
    verified,
    enrolledKeys: keys.size,
    agentIds: [...agents].sort(),
    samples: rows.slice(0, SAMPLE_SIZE).map((r) => ({ voucherId: r.id, requestHash: r.req_hash, agentId: r.agent_id })),
  };
}

/** Billed calls that repeated an identical earlier request (same seller and request hash) on this charge. */
export function repeatedCalls(db: Db, settlementId: string): DisputeReviewInput["repeats"] {
  const groups = stmt(
    db,
    `SELECT seller_id, req_hash, COUNT(*) AS n, SUM(price_micros) AS total, MIN(price_micros) AS first, MIN(method || ' ' || path) AS label
       FROM vouchers WHERE settlement_id = ? AND status = 'accepted'
      GROUP BY seller_id, req_hash HAVING COUNT(*) > 1 ORDER BY n DESC, seller_id`,
  ).all(settlementId) as Array<{ seller_id: string; req_hash: string; n: number; total: number; first: number; label: string }>;
  const top = groups[0];
  return {
    calls: groups.reduce((s, g) => s + g.n - 1, 0),
    micros: groups.reduce((s, g) => s + g.total - g.first, 0),
    sellerId: top?.seller_id ?? null,
    label: top?.label ?? null,
  };
}

export interface ChargeFacts {
  settlement: SettlementRow;
  tab: TabRow & { company_name: string | null };
  input: DisputeReviewInput;
}

/** The jury's input for a dispute linked to a completed tab charge; null for an unlinked dispute. */
export function chargeFacts(ctx: Pick<DisputeContext, "db" | "clock">, dispute: DisputeRow): ChargeFacts | null {
  const { db } = ctx;
  if (!dispute.settlement_id) return null;
  const settlement = stmt(db, "SELECT * FROM settlements WHERE id = ?").get(dispute.settlement_id) as SettlementRow | undefined;
  const tab = settlement
    ? (stmt(db, "SELECT t.*, c.name AS company_name FROM tabs t LEFT JOIN companies c ON c.id = t.company_id WHERE t.id = ?").get(settlement.tab_id) as
        | (TabRow & { company_name: string | null })
        | undefined)
    : undefined;
  if (!settlement || !tab) return null;
  const totals = tabTotals(db, tab, ctx.clock.now());
  const sellers = (
    stmt(
      db,
      `SELECT l.seller_id, s.name, l.calls, l.gross_micros FROM settlement_lines l LEFT JOIN sellers s ON s.id = l.seller_id
        WHERE l.settlement_id = ? ORDER BY l.gross_micros DESC, l.seller_id`,
    ).all(settlement.id) as Array<{ seller_id: string; name: string | null; calls: number; gross_micros: number }>
  ).map((l) => ({ sellerId: l.seller_id, sellerName: l.name, calls: l.calls, grossMicros: l.gross_micros }));
  const reviews = (
    stmt(
      db,
      `SELECT a.kind, r.verdict, r.fault, r.reason, r.decided_by FROM reviews r LEFT JOIN alarms a ON a.id = r.alarm_id
        WHERE r.tab_id = ? ORDER BY r.created_at, r.rowid`,
    ).all(tab.id) as Array<{ kind: string | null; verdict: string | null; fault: string | null; reason: string | null; decided_by: string | null }>
  ).map((r) => ({ alarmKind: r.kind, verdict: r.verdict, fault: r.fault, reason: r.reason, decidedBy: r.decided_by }));
  const input: DisputeReviewInput = {
    disputeId: dispute.id,
    reason: dispute.reason,
    status: dispute.status,
    stage: dispute.stage,
    amountCents: dispute.amount_cents,
    buyerMessage: dispute.buyer_message,
    companyName: tab.company_name,
    tab: {
      id: tab.id,
      holdCents: tab.hold_cents,
      calls: totals.calls,
      voided: totals.voided,
      voidedMicros: totals.voidedMicros,
      authorizedAt: tab.authorized_at,
      closedAt: tab.closed_at,
    },
    settlement: {
      id: settlement.id,
      captureId: settlement.capture_id,
      chargedCents: settlement.charged_cents,
      callCount: settlement.call_count,
      paypalFeeCents: settlement.paypal_fee_cents,
    },
    sellers,
    voidsByReason: voidStats(db, tab.id).byReason,
    signatures: verifySignatures(db, settlement.id, tab.id),
    reviews,
    repeats: repeatedCalls(db, settlement.id),
    frozenByReview: reviews.some((r) => r.verdict === "freeze"),
  };
  return { settlement, tab, input };
}

/** PayPal's limit for evidence notes and messages. */
export const PAYPAL_NOTE_MAX = 2_000;

/** The compact ledger summary appended to evidence: the charge, per-seller calls, signatures, voids, reviews. */
export function ledgerSummary(input: DisputeReviewInput): string {
  const sig = input.signatures;
  const sellers = input.sellers.map((s) => `${s.sellerName ?? s.sellerId} ${s.calls} calls ${formatUsd(s.grossMicros)}`).join("; ");
  const samples = sig.samples.map((v) => `${v.voucherId} (hash ${v.requestHash.slice(0, 10)})`).join(", ");
  const voids = Object.entries(input.voidsByReason)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(", ");
  const parts = [
    `Ledger (402 Fiatality): tab ${input.tab.id}, PayPal capture ${input.settlement.captureId ?? "n/a"}, ${formatCents(input.settlement.chargedCents)} for ${input.settlement.callCount} API calls.`,
    sellers ? `Per seller: ${sellers}.` : "",
    `Signed IOUs: ${sig.verified} of ${sig.billedCalls} billed calls carry a valid Ed25519 signature from ${sig.enrolledKeys} agent key(s) the buyer enrolled on its own tab${samples ? `, e.g. ${samples}` : ""}.`,
    input.tab.voided > 0 ? `Voided and never billed: ${input.tab.voided} ${input.tab.voided === 1 ? "call" : "calls"} (${voids}).` : "",
    input.reviews.length > 0 ? `AI spend reviews: ${input.reviews.map((r) => `${r.alarmKind ?? "alarm"} -> ${r.verdict ?? "pending"}`).join("; ")}.` : "",
  ];
  return parts.filter(Boolean).join(" ");
}

/** Evidence notes for PayPal: the jury's draft (or the human's note), then the ledger summary, within 2000 characters. */
export function composeEvidence(draft: string | null | undefined, input: DisputeReviewInput | null): string {
  const head = (draft ?? "").trim();
  const summary = input ? ledgerSummary(input) : "";
  const text = [head, summary].filter(Boolean).join("\n\n");
  return text.length <= PAYPAL_NOTE_MAX ? text : `${text.slice(0, PAYPAL_NOTE_MAX - 1).trimEnd()}…`;
}
