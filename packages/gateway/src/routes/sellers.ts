/** Seller registry and the public catalog (SPEC §5.2). */
import type { SellerEarningsDTO } from "@p402/shared";
import type { RoutePlugin } from "../context";
import { stmt } from "../db/db";
import { getSellerDTO, payoutItemDTO, settlementLineDTO, type PayoutItemRow, type SettlementLineRow } from "../db/dto";
import { notFound } from "../http/errors";
import { catalog, listSellerDTOs, registerSeller, updateSeller } from "../sellers/registry";

type IdParams = { Params: { id: string } };

export const sellerRoutes: RoutePlugin = async (app, { ctx }) => {
  app.get("/api/catalog", async () => catalog(ctx));

  app.get("/api/sellers", async () => listSellerDTOs(ctx));

  app.post("/api/sellers", async (request, reply) => {
    const seller = await registerSeller(ctx, request.body);
    return reply.code(201).send(seller);
  });

  app.patch<IdParams>("/api/sellers/:id", async (request) => updateSeller(ctx, request.params.id, request.body));

  app.get<IdParams>("/api/sellers/:id/earnings", async (request): Promise<SellerEarningsDTO> => {
    const seller = getSellerDTO(ctx.db, request.params.id, ctx.config.publicBaseUrl);
    if (!seller) throw notFound("Seller", request.params.id);
    const lines = stmt(
      ctx.db,
      `SELECT l.*, s.name AS seller_name, st.tab_id, st.created_at
         FROM settlement_lines l
         JOIN settlements st ON st.id = l.settlement_id
         LEFT JOIN sellers s ON s.id = l.seller_id
        WHERE l.seller_id = ? ORDER BY st.created_at DESC LIMIT 500`,
    ).all(seller.id) as Array<SettlementLineRow & { seller_name: string | null; tab_id: string; created_at: number }>;
    const payouts = stmt(
      ctx.db,
      `SELECT i.*, s.name AS seller_name, p.created_at
         FROM payout_items i
         JOIN payouts p ON p.id = i.payout_id
         LEFT JOIN sellers s ON s.id = i.seller_id
        WHERE i.seller_id = ? ORDER BY p.created_at DESC LIMIT 500`,
    ).all(seller.id) as Array<PayoutItemRow & { seller_name: string | null; created_at: number }>;
    return {
      seller,
      lines: lines.map((row) => ({ ...settlementLineDTO(row), settlementId: row.settlement_id, tabId: row.tab_id, createdAt: row.created_at })),
      payouts: payouts.map((row) => ({ ...payoutItemDTO(row), payoutId: row.payout_id, createdAt: row.created_at })),
    };
  });
};
