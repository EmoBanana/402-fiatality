/**
 * AG Studio's data model for the ledger: four in-browser tables built from the same DTOs the charts use.
 *
 *   vouchers     one row per paid API call (seller, tab, endpoint, status, void reason, price, latency)
 *   settlements  one row per settled tab (charged, PayPal fee, per-call fee it replaced, savings)
 *   sellers      one row per listed seller (balance, paid out, calls, voids)
 *   spend        billable spend per time bucket per seller (GET /api/metrics/timeseries, page range)
 *
 * Rows carry dollars as plain numbers and times as Date objects. Live changes reach Studio as
 * transactions (`diffRows`), so widgets update in place instead of reloading.
 */
import {
  effectiveRatePct,
  MICROS_PER_DOLLAR,
  type SellerDTO,
  type SettlementDTO,
  type TabDTO,
  type TimeseriesPointDTO,
  type VoucherDTO,
} from "@p402/shared";
import type { AgDataSourcesDefinition, AgDataTransaction, AgFieldDefinition, SimpleData } from "ag-studio";
import { tabLabel, voidLabel } from "../metrics";

export interface StudioSnapshot {
  vouchers: readonly VoucherDTO[];
  settlements: readonly SettlementDTO[];
  sellers: readonly SellerDTO[];
  tabs: readonly TabDTO[];
  /** The time series for the range picked on the page. */
  spend: readonly TimeseriesPointDTO[];
}

export type TableId = "vouchers" | "settlements" | "sellers" | "spend";
export type StudioRows = Record<TableId, SimpleData[]>;

const dollars = (micros: number) => micros / MICROS_PER_DOLLAR;
const MICRO_USD = "$#,##0.000";
const USD = "$#,##0.00";
const PCT = "#,##0.0%";

export function buildRows(s: StudioSnapshot): StudioRows {
  const names = new Map(s.sellers.map((x) => [x.id, x.name]));
  const tabs = new Map(s.tabs.map((t) => [t.id, t]));
  const sellerName = (id: string) => names.get(id) ?? id;

  const vouchers = s.vouchers.map<SimpleData>((v) => ({
    id: v.id,
    createdAt: new Date(v.createdAt),
    seller: sellerName(v.sellerId),
    tab: tabLabel(tabs.get(v.tabId), v.tabId),
    agent: v.agentId ?? null,
    endpoint: `${v.method} ${v.path}`,
    status: v.status === "accepted" ? "Accepted" : "Voided",
    voidReason: v.status === "voided" ? voidLabel(v.voidReason) : null,
    voided: v.status === "voided" ? 1 : 0,
    priceUsd: dollars(v.priceMicros),
    billedUsd: v.status === "accepted" ? dollars(v.priceMicros) : 0,
    latencyMs: v.latencyMs ?? null,
    httpStatus: v.httpStatus ?? null,
  }));

  const settlements = s.settlements
    .filter((x) => x.status === "completed")
    .map<SimpleData>((x) => ({
      id: x.id,
      tab: tabLabel(tabs.get(x.tabId), x.tabId),
      settledAt: new Date(x.createdAt),
      chargedUsd: x.chargedCents / 100,
      paypalFeeUsd: x.paypalFeeCents / 100,
      perCallFeeUsd: x.naiveFeeCents / 100,
      savedUsd: Math.max(0, x.naiveFeeCents - x.paypalFeeCents) / 100,
      feeRate: effectiveRatePct(x.paypalFeeCents, x.chargedCents) / 100,
      calls: x.callCount,
      voids: x.voidCount,
      voidedUsd: dollars(x.voidedMicros),
    }));

  const sellers = s.sellers.map<SimpleData>((x) => ({
    id: x.id,
    name: x.name,
    balanceUsd: dollars(x.balanceMicros),
    paidOutUsd: dollars(x.paidOutMicros),
    calls: x.stats.calls,
    voids: x.stats.voids,
    voidRate: x.stats.calls > 0 ? x.stats.voids / x.stats.calls : 0,
  }));

  const spend: SimpleData[] = [];
  for (const point of s.spend) {
    for (const [sellerId, micros] of Object.entries(point.bySeller)) {
      if (micros <= 0) continue;
      spend.push({ key: `${point.t}:${sellerId}`, time: new Date(point.t), seller: sellerName(sellerId), spendUsd: dollars(micros) });
    }
  }

  return { vouchers, settlements, sellers, spend };
}

const voucherFields: AgFieldDefinition[] = [
  { id: "id", name: "Voucher", format: "textFormat", cardinality: "high", description: "Voucher (signed IOU) id." },
  { id: "createdAt", name: "Time", format: "dateTimeFormat", description: "When the gateway accepted or voided the call." },
  { id: "seller", name: "Seller", format: "textFormat", cardinality: "low", description: "Seller API that was called." },
  { id: "tab", name: "Tab", format: "textFormat", cardinality: "low", description: "The company's PayPal tab (one hold) that paid." },
  { id: "agent", name: "Agent", format: "textFormat", cardinality: "low", blankValue: "–" },
  { id: "endpoint", name: "Endpoint", format: "textFormat", cardinality: "medium", description: "HTTP method and path on the seller API." },
  { id: "status", name: "Status", format: "textFormat", cardinality: "low", description: "Accepted (billable) or Voided (not billed)." },
  { id: "voidReason", name: "Void reason", format: "textFormat", cardinality: "low", blankValue: "–", description: "Why a call was voided; blank when accepted." },
  { id: "voided", name: "Voided", format: "percentageFormat", formatOptions: { format: PCT }, description: "1 when voided, else 0. Average = void rate." },
  { id: "priceUsd", name: "Price", format: "currencyFormat", formatOptions: { format: MICRO_USD }, description: "List price of the call in USD." },
  { id: "billedUsd", name: "Billed", format: "currencyFormat", formatOptions: { format: MICRO_USD }, description: "Price if accepted, 0 if voided." },
  { id: "latencyMs", name: "Latency (ms)", format: "integerFormat" },
  { id: "httpStatus", name: "HTTP status", format: "integerFormat", cardinality: "low" },
];

const settlementFields: AgFieldDefinition[] = [
  { id: "id", name: "Settlement", format: "textFormat", cardinality: "high" },
  { id: "tab", name: "Tab", format: "textFormat", cardinality: "low" },
  { id: "settledAt", name: "Settled", format: "dateTimeFormat" },
  { id: "chargedUsd", name: "Charged", format: "currencyFormat", formatOptions: { format: USD }, description: "The one PayPal capture for the tab." },
  { id: "paypalFeeUsd", name: "PayPal fee", format: "currencyFormat", formatOptions: { format: USD }, description: "PayPal's fee on that capture (3.49% + $0.49)." },
  { id: "perCallFeeUsd", name: "Per-call fees", format: "currencyFormat", formatOptions: { format: USD }, description: "What PayPal fees would be if every call were its own payment." },
  { id: "savedUsd", name: "Saved", format: "currencyFormat", formatOptions: { format: USD }, description: "Per-call fees minus the batched fee." },
  { id: "feeRate", name: "Fee rate", format: "percentageFormat", formatOptions: { format: "#,##0.00%" }, description: "PayPal fee divided by the amount charged." },
  { id: "calls", name: "Calls", format: "integerFormat" },
  { id: "voids", name: "Voided calls", format: "integerFormat" },
  { id: "voidedUsd", name: "Voided amount", format: "currencyFormat", formatOptions: { format: MICRO_USD } },
];

const sellerFields: AgFieldDefinition[] = [
  { id: "id", name: "Seller id", format: "textFormat", cardinality: "low" },
  { id: "name", name: "Seller", format: "textFormat", cardinality: "low" },
  { id: "balanceUsd", name: "Balance", format: "currencyFormat", formatOptions: { format: MICRO_USD }, description: "Owed, not yet paid out." },
  { id: "paidOutUsd", name: "Paid out", format: "currencyFormat", formatOptions: { format: USD } },
  { id: "calls", name: "Calls", format: "integerFormat" },
  { id: "voids", name: "Voids", format: "integerFormat" },
  { id: "voidRate", name: "Void rate", format: "percentageFormat", formatOptions: { format: PCT } },
];

const spendFields: AgFieldDefinition[] = [
  { id: "key", name: "Key", format: "textFormat", hide: true, cardinality: "high" },
  { id: "time", name: "Time bucket", format: "dateTimeFormat", description: "Start of the time bucket." },
  { id: "seller", name: "Seller", format: "textFormat", cardinality: "low" },
  { id: "spendUsd", name: "Spend", format: "currencyFormat", formatOptions: { format: MICRO_USD } },
];

export function buildDataDefinition(rows: StudioRows): AgDataSourcesDefinition {
  return {
    description:
      "PayPal 402 ledger. AI agents pay per API call with signed IOUs (vouchers) against one PayPal hold per company (a tab). " +
      "Accepted calls are billable; voided calls (seller errors, empty or malformed results, AI review) are never billed. " +
      "Each tab settles with one PayPal charge; per-call fees show what separate PayPal payments would have cost. Amounts are USD.",
    sources: [
      { id: "vouchers", name: "Paid calls", description: "One row per paid API call (voucher).", primaryKeyField: "id", transactions: "all", data: rows.vouchers, fields: voucherFields },
      { id: "settlements", name: "Settled tabs", description: "One row per tab settled with a single PayPal charge.", primaryKeyField: "id", transactions: "all", data: rows.settlements, fields: settlementFields },
      { id: "sellers", name: "Sellers", description: "Seller APIs, their balances and void rates.", primaryKeyField: "id", transactions: "all", data: rows.sellers, fields: sellerFields },
      { id: "spend", name: "Spend over time", description: "Billable spend per time bucket per seller, for the range picked above the charts.", primaryKeyField: "key", transactions: "all", data: rows.spend, fields: spendFields },
    ],
  };
}

function rowKey(table: TableId): string {
  return table === "spend" ? "key" : "id";
}

function same(a: SimpleData, b: SimpleData): boolean {
  for (const key of Object.keys(a)) {
    const x = a[key];
    const y = b[key];
    if (x instanceof Date && y instanceof Date) {
      if (x.getTime() !== y.getTime()) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/** Transactions that turn `prev` into `next`, one per changed table. */
export function diffRows(prev: StudioRows, next: StudioRows): AgDataTransaction[] {
  const out: AgDataTransaction[] = [];
  for (const table of Object.keys(next) as TableId[]) {
    const key = rowKey(table);
    const before = new Map(prev[table].map((r) => [String(r[key]), r]));
    const add: SimpleData[] = [];
    const update: SimpleData[] = [];
    const seen = new Set<string>();
    for (const row of next[table]) {
      const id = String(row[key]);
      seen.add(id);
      const old = before.get(id);
      if (!old) add.push(row);
      else if (!same(old, row)) update.push(row);
    }
    const remove = [...before.keys()].filter((id) => !seen.has(id));
    if (add.length || update.length || remove.length) {
      out.push({ tableId: table, ...(remove.length ? { remove } : {}), ...(update.length ? { update } : {}), ...(add.length ? { add } : {}) });
    }
  }
  return out;
}
