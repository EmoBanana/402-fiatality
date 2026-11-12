/**
 * Shared plumbing for the settlement modules: row loading, event emission, the company carry and
 * in-process locks.
 *
 * Carry storage: a company's pending sub-cent remainder lives in `kv` under `carry:<companyId>` (integer
 * micros as text). closeTab adds its carry-out there; createHold moves it into the new tab's
 * `carry_in_micros`; a tab that is cancelled before PayPal authorized it gives its carry-in back.
 */
import { DEFAULT_POLICY, type Policy, type PurchaseDTO } from "@p402/shared";
import { AppError, type AppContext } from "../context";
import { type Db, kvDelete, kvGet, kvSet, parseJson, stmt } from "../db/db";
import { getSellerDTO, getTabDTO, purchaseDTO, type PurchaseRefundRow, type PurchaseRow, type TabRow } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import type { SellerGross } from "./math";

/** What the settlement code needs from AppContext (tests may build exactly this). */
export type SettlementContext = Pick<AppContext, "config" | "db" | "bus" | "clock" | "log" | "paypal">;

/** Tabs the scheduler watches: authorized and not yet settled. */
export const OPEN_TAB_STATUSES = ["active", "paused", "frozen"] as const;

// ---------------------------------------------------------------- tabs

export function loadTab(db: Db, id: string): TabRow | null {
  return (stmt(db, "SELECT * FROM tabs WHERE id = ?").get(id) as TabRow | undefined) ?? null;
}

export function requireTab(db: Db, id: string): TabRow {
  const tab = loadTab(db, id);
  if (!tab) throw new AppError(404, "not_found", `Tab ${id} was not found.`);
  return tab;
}

export function tabPolicy(tab: Pick<TabRow, "policy">): Policy {
  const parsed = parseJson<Partial<Policy>>(tab.policy, {});
  return { ...DEFAULT_POLICY, ...parsed, alarms: { ...DEFAULT_POLICY.alarms, ...(parsed.alarms ?? {}) } };
}

/** The authorization a capture or void must use: the reauthorization once there is one. */
export function currentAuthorizationId(tab: Pick<TabRow, "authorization_id" | "reauth_authorization_id">): string | null {
  return tab.reauth_authorization_id ?? tab.authorization_id;
}

/** Accepted vouchers not yet in a settlement, grouped by seller. */
export function unsettledGross(db: Db, tabId: string): SellerGross[] {
  return (
    stmt(
      db,
      `SELECT seller_id, SUM(price_micros) AS gross, COUNT(*) AS calls FROM vouchers
        WHERE tab_id = ? AND status = 'accepted' AND settlement_id IS NULL GROUP BY seller_id ORDER BY seller_id`,
    ).all(tabId) as Array<{ seller_id: string; gross: number; calls: number }>
  ).map((r) => ({ sellerId: r.seller_id, grossMicros: r.gross, calls: r.calls }));
}

/** Accepted vouchers claimed by one settlement, grouped by seller. */
export function settlementGross(db: Db, settlementId: string): SellerGross[] {
  return (
    stmt(
      db,
      `SELECT seller_id, SUM(price_micros) AS gross, COUNT(*) AS calls FROM vouchers
        WHERE settlement_id = ? AND status = 'accepted' GROUP BY seller_id ORDER BY seller_id`,
    ).all(settlementId) as Array<{ seller_id: string; gross: number; calls: number }>
  ).map((r) => ({ sellerId: r.seller_id, grossMicros: r.gross, calls: r.calls }));
}

/** Σ accepted, unsettled voucher prices (add the tab's carry-in for SPEC §6.4's billable). */
export function unsettledBillableMicros(db: Db, tabId: string): number {
  const row = stmt(
    db,
    "SELECT COALESCE(SUM(price_micros), 0) AS total FROM vouchers WHERE tab_id = ? AND status = 'accepted' AND settlement_id IS NULL",
  ).get(tabId) as { total: number };
  return row.total;
}

export function inFlightVoucherCount(db: Db, tabId: string): number {
  return (stmt(db, "SELECT COUNT(*) AS n FROM vouchers WHERE tab_id = ? AND status = 'pending'").get(tabId) as { n: number }).n;
}

export interface VoidStats {
  count: number;
  micros: number;
  byReason: Record<string, number>;
}

export function voidStats(db: Db, tabId: string): VoidStats {
  const rows = stmt(
    db,
    `SELECT COALESCE(void_reason, 'unknown') AS reason, COUNT(*) AS n, SUM(price_micros) AS micros
       FROM vouchers WHERE tab_id = ? AND status = 'voided' GROUP BY reason ORDER BY reason`,
  ).all(tabId) as Array<{ reason: string; n: number; micros: number }>;
  return {
    count: rows.reduce((s, r) => s + r.n, 0),
    micros: rows.reduce((s, r) => s + r.micros, 0),
    byReason: Object.fromEntries(rows.map((r) => [r.reason, r.n])),
  };
}

export function loadPurchase(db: Db, id: string): PurchaseRow | null {
  return (stmt(db, "SELECT * FROM purchases WHERE id = ?").get(id) as PurchaseRow | undefined) ?? null;
}

/** Newest first. */
export function loadPurchaseRefunds(db: Db, purchaseId: string): PurchaseRefundRow[] {
  return stmt(db, "SELECT * FROM purchase_refunds WHERE purchase_id = ? ORDER BY created_at DESC, rowid DESC").all(
    purchaseId,
  ) as PurchaseRefundRow[];
}

/** A purchase as the API shows it, refunds included. */
export function purchaseView(db: Db, row: PurchaseRow): PurchaseDTO {
  return purchaseDTO(row, loadPurchaseRefunds(db, row.id));
}

// ---------------------------------------------------------------- events

export function emitTab(ctx: Pick<AppContext, "db" | "bus" | "clock">, tabId: string): void {
  const dto = getTabDTO(ctx.db, tabId, ctx.clock.now());
  if (dto) ctx.bus.emit("tab.updated", dto);
}

export function emitSellers(ctx: Pick<AppContext, "db" | "bus" | "config">, sellerIds: Iterable<string>): void {
  for (const id of new Set(sellerIds)) {
    const dto = getSellerDTO(ctx.db, id, ctx.config.publicBaseUrl);
    if (dto) ctx.bus.emit("seller.updated", dto);
  }
}

export function emitPurchase(ctx: Pick<AppContext, "db" | "bus">, purchaseId: string): void {
  const row = loadPurchase(ctx.db, purchaseId);
  if (row) ctx.bus.emit("purchase.updated", purchaseView(ctx.db, row));
}

// ---------------------------------------------------------------- carry

const carryKey = (companyId: string) => `carry:${companyId}`;

export function pendingCarry(db: Db, companyId: string): number {
  return Number(kvGet(db, carryKey(companyId)) ?? 0) || 0;
}

/** Remove and return the company's pending carry. Call inside the transaction that stores it elsewhere. */
export function takeCarry(db: Db, companyId: string): number {
  const micros = pendingCarry(db, companyId);
  if (micros !== 0) kvDelete(db, carryKey(companyId));
  return micros;
}

export function addCarry(db: Db, companyId: string, micros: number): void {
  if (micros === 0) return;
  kvSet(db, carryKey(companyId), String(pendingCarry(db, companyId) + micros));
}

// ---------------------------------------------------------------- locks

const lockTails = new WeakMap<Db, Map<string, Promise<void>>>();

/**
 * Serialize async work per key (per database, so separate test contexts never block each other). A second
 * close of the same tab waits for the first and then finds it settled; PayPal calls inside stay idempotent
 * through PayPal-Request-Id for the cross-process case.
 */
export async function withLock<T>(db: Db, key: string, fn: () => Promise<T>): Promise<T> {
  let tails = lockTails.get(db);
  if (!tails) lockTails.set(db, (tails = new Map()));
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => mine);
  tails.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export function isLocked(db: Db, key: string): boolean {
  return lockTails.get(db)?.has(key) ?? false;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Log fields for any error. PayPal errors give name/debug_id/issues; never request data or tokens. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof PaypalError) return err.toLog();
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { message: err.message };
  return { message: String(err) };
}
