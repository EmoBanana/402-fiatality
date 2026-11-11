/**
 * Disputes in the ledger and their money rules.
 *
 * - A dispute is linked to the tab charge it disputes by capture id (settlements.capture_id). Unlinked
 *   disputes (another capture of the merchant) are listed with null ids and touch no balances.
 * - While unresolved, the linked tab's sellers have part of their net from that charge held back from payouts
 *   (amount ÷ charged; see disputeHolds in db/dto.ts). Resolving releases the hold.
 * - When it resolves with money back to the buyer, the refunded cents (from PayPal's data) are deducted from the
 *   tab's sellers pro rata by gross, exactly once: `refund_applied_cents` advances in the same transaction that
 *   writes `dispute_refunds` and the balances, so a later sync applies only an increase, never the same refund.
 */
import { allocateProRata, MICROS_PER_CENT, type DisputeActionDTO, type DisputeJuryDTO } from "@p402/shared";
import type { AppContext, PaypalDispute } from "../context";
import { type Db, parseJson, stmt, tx } from "../db/db";
import { getDisputeDTO, getDisputeRow, type DisputeRow, type SettlementRow } from "../db/dto";
import { emitSellers } from "../settlement/store";

export type DisputeContext = Pick<AppContext, "config" | "db" | "bus" | "clock" | "log" | "paypal">;

/** Outcome codes that mean the buyer got money back from the merchant (when PayPal names no amount, the disputed amount). */
export const BUYER_FAVOUR_OUTCOMES: ReadonlySet<string> = new Set(["RESOLVED_BUYER_FAVOUR", "ACCEPTED"]);

const MAX_ACTIONS = 50;

interface Link {
  settlement: SettlementRow | null;
  tabId: string | null;
  companyId: string | null;
  captureId: string | null;
}

/** The completed tab charge behind one of the dispute's capture ids. */
export function linkDispute(db: Db, captureIds: string[]): Link {
  for (const captureId of captureIds) {
    const settlement = stmt(db, "SELECT * FROM settlements WHERE capture_id = ? ORDER BY created_at DESC LIMIT 1").get(captureId) as
      | SettlementRow
      | undefined;
    if (settlement) {
      const tab = stmt(db, "SELECT company_id FROM tabs WHERE id = ?").get(settlement.tab_id) as { company_id: string } | undefined;
      return { settlement, tabId: settlement.tab_id, companyId: tab?.company_id ?? null, captureId };
    }
  }
  return { settlement: null, tabId: null, companyId: null, captureId: captureIds[0] ?? null };
}

/** Money back to the buyer, in cents: PayPal's figure, else the disputed amount for a buyer-favour outcome. */
export function moneyBackCents(d: PaypalDispute, chargedCents: number | null): number {
  let cents = d.refundedCents ?? (d.status === "RESOLVED" && d.outcome && BUYER_FAVOUR_OUTCOMES.has(d.outcome) ? d.amountCents : 0);
  if (chargedCents != null) cents = Math.min(cents, chargedCents);
  return Math.max(0, Math.round(cents));
}

export interface UpsertResult {
  row: DisputeRow;
  created: boolean;
  changed: boolean;
  /** Sellers whose held or available balance moved. */
  sellers: string[];
}

/** Insert or refresh a dispute from PayPal and apply its money rules, in one transaction. */
export function upsertDispute(ctx: DisputeContext, d: PaypalDispute): UpsertResult {
  const { db } = ctx;
  return tx(db, () => {
    const existing = getDisputeRow(db, d.id);
    const link = linkDispute(db, d.captureIds);
    // A link found once is kept even if a later PayPal answer omits the transactions.
    const settlementId = link.settlement?.id ?? existing?.settlement_id ?? null;
    const charged = link.settlement?.charged_cents ?? (settlementId ? chargedCentsOf(db, settlementId) : null);
    const now = ctx.clock.now();
    const fields = {
      settlement_id: settlementId,
      tab_id: link.tabId ?? existing?.tab_id ?? null,
      company_id: link.companyId ?? existing?.company_id ?? null,
      capture_id: link.captureId ?? existing?.capture_id ?? null,
      status: d.status,
      reason: d.reason,
      stage: d.stage,
      amount_cents: d.amountCents,
      outcome: d.outcome,
      refunded_cents: moneyBackCents(d, charged),
      buyer_message: d.buyerMessage ?? existing?.buyer_message ?? null,
      seller_response_due_at: d.sellerResponseDueAt,
      paypal_actions: JSON.stringify(d.actions),
      paypal_updated_at: d.updatedAt,
    };

    let created = false;
    let changed = false;
    if (!existing) {
      stmt(
        db,
        `INSERT INTO disputes (id, settlement_id, tab_id, company_id, capture_id, status, reason, stage, amount_cents, outcome,
                               refunded_cents, refund_applied_cents, buyer_message, seller_response_due_at, paypal_actions,
                               paypal_updated_at, jury, actions, created_at, updated_at)
         VALUES (@id, @settlement_id, @tab_id, @company_id, @capture_id, @status, @reason, @stage, @amount_cents, @outcome,
                 @refunded_cents, 0, @buyer_message, @seller_response_due_at, @paypal_actions, @paypal_updated_at, NULL, '[]',
                 @created_at, @updated_at)`,
      ).run({ id: d.id, ...fields, created_at: d.createdAt ?? now, updated_at: now });
      created = true;
    } else {
      changed = (Object.keys(fields) as Array<keyof typeof fields>).some((key) => existing[key] !== fields[key]);
      if (changed) {
        stmt(
          db,
          `UPDATE disputes SET settlement_id = @settlement_id, tab_id = @tab_id, company_id = @company_id, capture_id = @capture_id,
                  status = @status, reason = @reason, stage = @stage, amount_cents = @amount_cents, outcome = @outcome,
                  refunded_cents = @refunded_cents, buyer_message = @buyer_message, seller_response_due_at = @seller_response_due_at,
                  paypal_actions = @paypal_actions, paypal_updated_at = @paypal_updated_at, updated_at = @updated_at
            WHERE id = @id`,
        ).run({ id: d.id, ...fields, updated_at: now });
      }
    }

    const sellers = new Set<string>();
    const holdMoved = settlementId && (created || existing?.status !== fields.status || existing?.amount_cents !== fields.amount_cents);
    if (holdMoved) for (const id of settlementSellers(db, settlementId)) sellers.add(id);
    if (settlementId && fields.status === "RESOLVED") {
      for (const id of applyRefund(ctx, d.id, settlementId, fields.refunded_cents)) sellers.add(id);
    }
    const row = getDisputeRow(db, d.id) as DisputeRow;
    return { row, created, changed: changed || sellers.size > 0, sellers: [...sellers] };
  });
}

function chargedCentsOf(db: Db, settlementId: string): number | null {
  return (stmt(db, "SELECT charged_cents FROM settlements WHERE id = ?").get(settlementId) as { charged_cents: number } | undefined)?.charged_cents ?? null;
}

function settlementSellers(db: Db, settlementId: string): string[] {
  return (stmt(db, "SELECT seller_id FROM settlement_lines WHERE settlement_id = ? ORDER BY seller_id").all(settlementId) as Array<{ seller_id: string }>).map(
    (r) => r.seller_id,
  );
}

/**
 * Deduct what PayPal gave back to the buyer and has not been deducted yet, pro rata by each seller's gross on the
 * disputed charge. Inside the caller's transaction. Returns the sellers charged.
 */
export function applyRefund(ctx: Pick<DisputeContext, "db" | "clock" | "log">, disputeId: string, settlementId: string, refundedCents: number): string[] {
  const { db } = ctx;
  const row = getDisputeRow(db, disputeId);
  if (!row) return [];
  const delta = refundedCents - row.refund_applied_cents;
  if (delta <= 0) return [];
  const lines = stmt(db, "SELECT seller_id, gross_micros FROM settlement_lines WHERE settlement_id = ?").all(settlementId) as Array<{
    seller_id: string;
    gross_micros: number;
  }>;
  const parts = allocateProRata(delta * MICROS_PER_CENT, Object.fromEntries(lines.map((l) => [l.seller_id, l.gross_micros])));
  const now = ctx.clock.now();
  const charged: string[] = [];
  for (const [sellerId, micros] of Object.entries(parts)) {
    if (micros === 0) continue;
    stmt(
      db,
      `INSERT INTO dispute_refunds (dispute_id, seller_id, amount_micros, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(dispute_id, seller_id) DO UPDATE SET amount_micros = amount_micros + excluded.amount_micros, updated_at = excluded.updated_at`,
    ).run(disputeId, sellerId, micros, now);
    stmt(
      db,
      `INSERT INTO seller_balances (seller_id, available_micros, paid_out_micros, updated_at) VALUES (?, ?, 0, ?)
       ON CONFLICT(seller_id) DO UPDATE SET available_micros = available_micros + excluded.available_micros, updated_at = excluded.updated_at`,
    ).run(sellerId, -micros, now);
    charged.push(sellerId);
  }
  stmt(db, "UPDATE disputes SET refund_applied_cents = ? WHERE id = ?").run(refundedCents, disputeId);
  ctx.log.info({ disputeId, settlementId, refundedCents: delta }, "dispute refund deducted from sellers");
  return charged;
}

/** Append an action to the dispute's record (newest last, capped). */
export function recordAction(ctx: Pick<DisputeContext, "db" | "clock">, disputeId: string, action: DisputeActionDTO): void {
  const row = getDisputeRow(ctx.db, disputeId);
  if (!row) return;
  const actions = [...parseJson<DisputeActionDTO[]>(row.actions, []), action].slice(-MAX_ACTIONS);
  stmt(ctx.db, "UPDATE disputes SET actions = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(actions), ctx.clock.now(), disputeId);
}

export function saveJury(ctx: Pick<DisputeContext, "db" | "clock">, disputeId: string, jury: DisputeJuryDTO): void {
  stmt(ctx.db, "UPDATE disputes SET jury = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(jury), ctx.clock.now(), disputeId);
}

export function emitDispute(ctx: Pick<DisputeContext, "db" | "bus">, disputeId: string): void {
  const dto = getDisputeDTO(ctx.db, disputeId);
  if (dto) ctx.bus.emit("dispute.updated", dto);
}

/** After an upsert: tell clients about the dispute and any sellers whose balances moved. */
export function announce(ctx: DisputeContext, result: Pick<UpsertResult, "row" | "created" | "changed" | "sellers">): void {
  if (result.created || result.changed) emitDispute(ctx, result.row.id);
  if (result.sellers.length > 0) emitSellers(ctx, result.sellers);
}
