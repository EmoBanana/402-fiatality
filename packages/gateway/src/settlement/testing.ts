/**
 * Test fixtures for the settlement and PayPal tests: an offline context with the mock PayPal and the real
 * settlement service, a controllable clock, seed rows and a helper that opens an approved tab.
 * Not used by the running gateway.
 */
import { normalizePolicy, type GatewayEvent, type Policy, type VoidReason } from "@p402/shared";
import { createTestContext, type AppConfig, type AppContext, type PaypalClient } from "../context";
import { stmt } from "../db/db";
import { createPaypalClient } from "../paypal";
import { approveMockOrder } from "../paypal/mock";
import { completeApproval } from "./approvals";
import { createSettlementService } from "./index";

/** 2026-11-08 12:00 UTC: the "real" time under the gateway clock in tests. */
export const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
export const COMPANY_ID = "co_northwind";

export interface TestHarness {
  ctx: AppContext;
  /** Move real time forward (works with DEMO_MODE on or off). */
  advance(ms: number): void;
  /** Every event emitted on the bus. */
  events: GatewayEvent[];
  /** Calls made to PayPal, by method name. */
  calls: Record<string, number>;
}

/** Wraps a PaypalClient to count calls per method (and lets tests swap in failures). */
function counting(client: PaypalClient, calls: Record<string, number>): PaypalClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        calls[prop] = (calls[prop] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export function createHarness(opts: { config?: Partial<AppConfig>; seed?: boolean } = {}): TestHarness {
  let now = T0;
  const calls: Record<string, number> = {};
  const ctx = createTestContext({
    realNow: () => now,
    config: opts.config,
    paypal: (c) => counting(createPaypalClient(c), calls),
    settlement: (c) => createSettlementService(c),
  });
  const events: GatewayEvent[] = [];
  ctx.bus.subscribe((e) => events.push(e));
  if (opts.seed !== false) seedBasics(ctx);
  return { ctx, events, calls, advance: (ms) => void (now += ms) };
}

export function seedBasics(ctx: AppContext): void {
  stmt(ctx.db, "INSERT INTO companies (id, name, created_at) VALUES (?, ?, ?)").run(COMPANY_ID, "Northwind Research", T0);
  const seller = stmt(
    ctx.db,
    "INSERT INTO sellers (id, name, base_url, paypal_email, void_rules, created_at) VALUES (?, ?, ?, ?, '{}', ?)",
  );
  seller.run("channel3", "Channel3", "http://localhost:4030/channel3", "channel3@example.com", T0);
  seller.run("pricewatch", "PriceWatch", "http://localhost:4030/pricewatch", "pricewatch@example.com", T0);
  seller.run("reviews", "Reviews", "http://localhost:4030/reviews", "reviews@example.com", T0);
}

export interface OpenedTab {
  tabId: string;
  orderId: string;
  enrollToken: string;
}

/** createHold + mock approval + return handler: an active tab. */
export async function openTab(ctx: AppContext, policy: Partial<Policy> = {}, companyId = COMPANY_ID): Promise<OpenedTab> {
  const created = await ctx.settlement.createHold({ companyId, policy: normalizePolicy(policy) });
  approveMockOrder(ctx.db, created.orderId);
  const message = await completeApproval(ctx, "tab", created.tab.id, created.orderId);
  if (message.status !== "approved") throw new Error(`tab approval failed: ${message.message ?? message.status}`);
  return { tabId: created.tab.id, orderId: created.orderId, enrollToken: created.enrollToken };
}

let voucherCounter = 0;

/** Insert judged vouchers for one seller with consecutive seq/cumulative values. Returns their ids. */
export function addVouchers(
  ctx: AppContext,
  tabId: string,
  sellerId: string,
  count: number,
  priceMicros: number,
  opts: { status?: "accepted" | "voided" | "pending"; voidReason?: VoidReason } = {},
): string[] {
  const last = stmt(
    ctx.db,
    "SELECT COALESCE(MAX(seq), 0) AS seq, COALESCE(MAX(cumulative_micros), 0) AS cum FROM vouchers WHERE tab_id = ? AND seller_id = ?",
  ).get(tabId, sellerId) as { seq: number; cum: number };
  const insert = stmt(
    ctx.db,
    `INSERT INTO vouchers (id, tab_id, seller_id, seq, price_micros, cumulative_micros, req_hash, method, path, status,
                           void_reason, signature, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'GET', '/v1/test', ?, ?, 'sig', ?)`,
  );
  const ids: string[] = [];
  const status = opts.status ?? "accepted";
  for (let i = 1; i <= count; i++) {
    const id = `v_${++voucherCounter}`;
    insert.run(
      id,
      tabId,
      sellerId,
      last.seq + i,
      priceMicros,
      last.cum + i * priceMicros,
      `rh_${voucherCounter}`,
      status,
      status === "voided" ? (opts.voidReason ?? "upstream_5xx") : null,
      ctx.clock.now(),
    );
    ids.push(id);
  }
  return ids;
}

export function setBalance(ctx: AppContext, sellerId: string, availableMicros: number): void {
  stmt(
    ctx.db,
    `INSERT INTO seller_balances (seller_id, available_micros, paid_out_micros, updated_at) VALUES (?, ?, 0, ?)
     ON CONFLICT(seller_id) DO UPDATE SET available_micros = excluded.available_micros`,
  ).run(sellerId, availableMicros, T0);
}

export function balanceOf(ctx: AppContext, sellerId: string): { available: number; paidOut: number } {
  const row = stmt(ctx.db, "SELECT available_micros, paid_out_micros FROM seller_balances WHERE seller_id = ?").get(sellerId) as
    | { available_micros: number; paid_out_micros: number }
    | undefined;
  return { available: row?.available_micros ?? 0, paidOut: row?.paid_out_micros ?? 0 };
}
