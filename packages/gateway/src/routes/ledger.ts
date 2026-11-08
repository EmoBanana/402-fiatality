/** Read access to the ledger (vouchers, alarms, reviews) and the human review decision. */
import type { AlarmDTO, ReviewDTO, VoucherDTO } from "@p402/shared";
import { z } from "zod";
import type { RoutePlugin } from "../context";
import { coreOf } from "../core";
import { stmt } from "../db/db";
import { alarmDTO, reviewDTO, voucherDTO, type AlarmRow, type ReviewRow, type VoucherRow } from "../db/dto";
import { parseInput } from "../http/errors";

const id = z.string().min(1).max(64);

const voucherQuery = z.object({
  tabId: id.optional(),
  sellerId: id.optional(),
  status: z.enum(["accepted", "voided"]).optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(200),
  before: z.coerce.number().int().min(0).optional(),
});

const tabFilter = z.object({ tabId: id.optional() });

const alarmQuery = tabFilter.extend({ status: z.enum(["open", "reviewing", "resolved"]).optional() });

/** Builds "WHERE a = ? AND b = ?" from the defined filters (column names are fixed here, values are bound). */
function where(filters: Array<[column: string, op: string, value: unknown]>): { sql: string; params: unknown[] } {
  const defined = filters.filter(([, , value]) => value !== undefined);
  return {
    sql: defined.length ? ` AND ${defined.map(([column, op]) => `${column} ${op} ?`).join(" AND ")}` : "",
    params: defined.map(([, , value]) => value),
  };
}

export const ledgerRoutes: RoutePlugin = async (app, { ctx }) => {
  app.get("/api/vouchers", async (request): Promise<VoucherDTO[]> => {
    const q = parseInput(voucherQuery, request.query);
    const w = where([
      ["tab_id", "=", q.tabId],
      ["seller_id", "=", q.sellerId],
      ["status", "=", q.status],
      ["created_at", "<", q.before],
    ]);
    const rows = ctx.db
      .prepare(`SELECT * FROM vouchers WHERE status != 'pending'${w.sql} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...w.params, q.limit) as VoucherRow[];
    return rows.map(voucherDTO);
  });

  app.get("/api/alarms", async (request): Promise<AlarmDTO[]> => {
    const q = parseInput(alarmQuery, request.query);
    const w = where([
      ["tab_id", "=", q.tabId],
      ["status", "=", q.status],
    ]);
    const rows = ctx.db.prepare(`SELECT * FROM alarms WHERE 1 = 1${w.sql} ORDER BY created_at DESC LIMIT 500`).all(...w.params) as AlarmRow[];
    return rows.map(alarmDTO);
  });

  app.get("/api/reviews", async (request): Promise<ReviewDTO[]> => {
    const q = parseInput(tabFilter, request.query);
    const w = where([["tab_id", "=", q.tabId]]);
    const rows = ctx.db.prepare(`SELECT * FROM reviews WHERE 1 = 1${w.sql} ORDER BY created_at DESC LIMIT 200`).all(...w.params) as ReviewRow[];
    return rows.map(reviewDTO);
  });

  app.post<{ Params: { id: string } }>("/api/reviews/:id/decide", async (request) =>
    coreOf(ctx).reviews.decide(request.params.id, request.body),
  );
};
