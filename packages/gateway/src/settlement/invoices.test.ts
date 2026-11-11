/** Invoice records (PAYPAL_INVOICE_RECORDS=1) on the mock PayPal: one paid invoice per charge, best effort, retried. */
import { describe, expect, it } from "vitest";
import { testConfig } from "../config";
import { stmt } from "../db/db";
import { getInvoiceDTO, invoiceNumber, recordInvoice } from "./invoices";
import { addVouchers, createHarness, openTab } from "./testing";

const withInvoices = () => createHarness({ config: { paypal: { ...testConfig().paypal, invoiceRecords: true } } });

async function charge(h: ReturnType<typeof createHarness>) {
  const { tabId } = await openTab(h.ctx);
  addVouchers(h.ctx, tabId, "channel3", 2_000, 5_000); // $10
  addVouchers(h.ctx, tabId, "pricewatch", 500, 10_000); // $5
  return h.ctx.settlement.closeTab(tabId, "manual");
}

describe("invoice records", () => {
  it("records each charge as a paid invoice numbered FIAT-<settlement>, once", async () => {
    const h = withInvoices();
    const settlement = await charge(h);
    const invoice = await recordInvoice(h.ctx, settlement.id);
    expect(invoice).toMatchObject({ settlementId: settlement.id, invoiceNumber: `FIAT-${settlement.id}`, status: "MARKED_AS_PAID", amountCents: 1_500 });
    expect(invoice?.id).toMatch(/^MOCK-INV-/);
    expect(invoiceNumber(settlement.id)).toHaveLength(25);
    expect(await recordInvoice(h.ctx, settlement.id)).toEqual(invoice);
    expect(getInvoiceDTO(h.ctx.db, settlement.id)).toEqual(invoice);
    expect(h.calls.createInvoiceRecord).toBe(1);
  });

  it("is off unless PAYPAL_INVOICE_RECORDS=1, and skips $0 closes", async () => {
    const off = createHarness();
    const settlement = await charge(off);
    await off.ctx.settlement.tick();
    expect(off.calls.createInvoiceRecord ?? 0).toBe(0);
    expect(getInvoiceDTO(off.ctx.db, settlement.id)).toBeNull();

    const h = withInvoices();
    const { tabId } = await openTab(h.ctx);
    const zero = await h.ctx.settlement.closeTab(tabId, "manual");
    expect(zero.chargedCents).toBe(0);
    expect(await recordInvoice(h.ctx, zero.id)).toBeNull();
  });

  it("never fails a settlement and retries on the scheduler after a back-off", async () => {
    const h = withInvoices();
    const real = h.ctx.paypal;
    let failing = true;
    h.ctx.paypal = {
      ...real,
      mode: real.mode,
      createInvoiceRecord: async (input) => {
        if (failing) throw new Error("PayPal Invoicing is down");
        return real.createInvoiceRecord(input);
      },
    };
    const settlement = await charge(h);
    expect(settlement.status).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM invoices").get()).toEqual({ n: 0 });
    failing = false;
    await h.ctx.settlement.tick(); // still inside the back-off
    expect(stmt(h.ctx.db, "SELECT COUNT(*) AS n FROM invoices").get()).toEqual({ n: 0 });
    h.advance(6 * 60_000);
    await h.ctx.settlement.tick();
    expect(stmt(h.ctx.db, "SELECT settlement_id, status FROM invoices").all()).toEqual([{ settlement_id: settlement.id, status: "MARKED_AS_PAID" }]);
  });
});
