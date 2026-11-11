/**
 * Invoice records (PAYPAL_INVOICE_RECORDS=1, SPEC §6.7): each tab charge is recorded in PayPal Invoicing as a
 * paid invoice, numbered FIAT-<settlementId>, billed to the payer of the hold, with one line for the charge whose
 * description gives the per-seller gross and calls and the capture id. Best effort: it never fails a settlement,
 * and the scheduler retries completed charges that have no paid invoice yet. Mock ids are MOCK-INV-...
 */
import { formatUsd, type InvoiceDTO } from "@p402/shared";
import { type Db, kvGet, kvSet, stmt } from "../db/db";
import type { SettlementRow } from "../db/dto";
import { realNow } from "./holds";
import { errorFields, isLocked, loadTab, type SettlementContext, withLock } from "./store";

/** Real time between attempts for one charge. */
export const INVOICE_RETRY_MS = 5 * 60_000;
/** Charges retried per scheduler run. */
const RETRY_BATCH = 5;
export const PAID_INVOICE_STATUSES: ReadonlySet<string> = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);
const failedKey = (settlementId: string) => `invoice:failed:${settlementId}`;

export interface InvoiceRow {
  id: string;
  settlement_id: string;
  invoice_number: string;
  status: string;
  amount_cents: number;
  url: string | null;
  created_at: number;
}

export function invoiceDTO(row: InvoiceRow): InvoiceDTO {
  return {
    id: row.id,
    settlementId: row.settlement_id,
    invoiceNumber: row.invoice_number,
    status: row.status,
    amountCents: row.amount_cents,
    url: row.url,
    createdAt: row.created_at,
  };
}

/** The invoice recorded for a charge, if any. */
export function getInvoiceDTO(db: Db, settlementId: string): InvoiceDTO | null {
  const row = stmt(db, "SELECT * FROM invoices WHERE settlement_id = ?").get(settlementId) as InvoiceRow | undefined;
  return row ? invoiceDTO(row) : null;
}

/** PayPal allows 25 characters: "FIAT-" + a 20-character settlement id. */
export function invoiceNumber(settlementId: string): string {
  return `FIAT-${settlementId}`.slice(0, 25);
}

/** Create (or finish) the paid invoice for a completed charge. Null when there is nothing to invoice. */
export async function recordInvoice(ctx: SettlementContext, settlementId: string): Promise<InvoiceDTO | null> {
  return withLock(ctx.db, `invoice:${settlementId}`, async () => {
    const { db } = ctx;
    const existing = getInvoiceDTO(db, settlementId);
    if (existing && PAID_INVOICE_STATUSES.has(existing.status)) return existing;
    const settlement = stmt(db, "SELECT * FROM settlements WHERE id = ?").get(settlementId) as SettlementRow | undefined;
    if (!settlement || settlement.status !== "completed" || settlement.charged_cents <= 0 || !settlement.capture_id) return null;
    const tab = loadTab(db, settlement.tab_id);
    const captureId = settlement.capture_id;
    // The payer of the hold, when PayPal tells us (best effort: an invoice without a recipient is still a record).
    const recipientEmail = tab?.paypal_order_id ? await ctx.paypal.getOrder(tab.paypal_order_id).then((o) => o.payerEmail ?? null, () => null) : null;
    const lines = stmt(
      db,
      `SELECT l.seller_id, s.name, l.calls, l.gross_micros FROM settlement_lines l LEFT JOIN sellers s ON s.id = l.seller_id
        WHERE l.settlement_id = ? ORDER BY l.gross_micros DESC, l.seller_id`,
    ).all(settlementId) as Array<{ seller_id: string; name: string | null; calls: number; gross_micros: number }>;
    const perSeller = lines.map((l) => `${l.name ?? l.seller_id}: ${l.calls} ${l.calls === 1 ? "call" : "calls"}, ${formatUsd(l.gross_micros)}`).join("; ");
    const invoice = await ctx.paypal.createInvoiceRecord({
      invoiceNumber: invoiceNumber(settlementId),
      reference: settlement.tab_id,
      recipientEmail,
      itemName: "Agent API usage",
      itemDescription: `${perSeller || "No seller lines"}. Paid by PayPal capture ${captureId}.`,
      amountCents: settlement.charged_cents,
      note: `One charge for ${settlement.call_count} API calls your AI agents made on tab ${settlement.tab_id}. Already paid with PayPal (capture ${captureId}).`,
      memo: `402 Fiatality tab ${settlement.tab_id}, settlement ${settlementId}, capture ${captureId}`,
      paymentNote: `Paid by PayPal capture ${captureId}`,
      requestId: `invoice-${settlementId}`,
    });
    stmt(
      db,
      `INSERT INTO invoices (id, settlement_id, invoice_number, status, amount_cents, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(settlement_id) DO UPDATE SET id = excluded.id, invoice_number = excluded.invoice_number, status = excluded.status,
         amount_cents = excluded.amount_cents, url = COALESCE(excluded.url, invoices.url)`,
    ).run(invoice.id, settlementId, invoice.invoiceNumber || invoiceNumber(settlementId), invoice.status, invoice.amountCents || settlement.charged_cents, invoice.url, ctx.clock.now());
    ctx.log.info({ settlementId, invoiceId: invoice.id, status: invoice.status }, "charge recorded as a paid PayPal invoice");
    return getInvoiceDTO(db, settlementId);
  });
}

async function attemptInvoice(ctx: SettlementContext, settlementId: string): Promise<void> {
  try {
    await recordInvoice(ctx, settlementId);
  } catch (err) {
    kvSet(ctx.db, failedKey(settlementId), String(realNow(ctx)));
    ctx.log.warn({ settlementId, ...errorFields(err) }, "invoice record failed; the scheduler retries");
  }
}

/** After a charge: record its invoice in the background (never fails or delays the settlement). */
export function queueInvoice(ctx: SettlementContext, settlementId: string): void {
  if (!ctx.config.paypal.invoiceRecords) return;
  void attemptInvoice(ctx, settlementId);
}

/** Scheduler: completed charges without a paid invoice, a few per run, each at most every INVOICE_RETRY_MS. */
export async function retryInvoices(ctx: SettlementContext): Promise<void> {
  if (!ctx.config.paypal.invoiceRecords) return;
  const due = stmt(
    ctx.db,
    `SELECT s.id FROM settlements s LEFT JOIN invoices i ON i.settlement_id = s.id
      WHERE s.status = 'completed' AND s.charged_cents > 0 AND s.capture_id IS NOT NULL
        AND (i.id IS NULL OR i.status NOT IN ('PAID', 'MARKED_AS_PAID', 'PAID_EXTERNAL'))
      ORDER BY s.created_at DESC LIMIT 50`,
  ).all() as Array<{ id: string }>;
  let tried = 0;
  for (const { id } of due) {
    if (tried >= RETRY_BATCH) break;
    if (isLocked(ctx.db, `invoice:${id}`)) continue;
    const failedAt = Number(kvGet(ctx.db, failedKey(id)) ?? 0);
    if (failedAt > 0 && realNow(ctx) - failedAt < INVOICE_RETRY_MS) continue;
    tried++;
    await attemptInvoice(ctx, id);
  }
}
