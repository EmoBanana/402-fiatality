/**
 * GET /api/tabs/:id/statement (SPEC §6.7): per-seller lines, voids by reason, the PayPal fee and its rate,
 * and what per-call payments would have cost. A tab that is not settled yet gets a preview: what closing
 * it now would charge, with the fee at the published rate.
 */
import { effectiveRatePct, type SettlementLineDTO, type StatementDTO } from "@p402/shared";
import { AppError } from "../context";
import { stmt } from "../db/db";
import { companyDTO, getTabDTO, settlementDTO, type CompanyRow } from "../db/dto";
import { latestSettlement } from "./close";
import { allocateLines, estimatedFeeCents, planSettlement } from "./math";
import { requireTab, type SettlementContext, unsettledGross, voidStats } from "./store";

export async function statement(ctx: SettlementContext, tabId: string): Promise<StatementDTO> {
  const { db } = ctx;
  const now = ctx.clock.now();
  const row = requireTab(db, tabId);
  const tab = getTabDTO(db, tabId, now);
  const company = stmt(db, "SELECT * FROM companies WHERE id = ?").get(row.company_id) as CompanyRow | undefined;
  if (!tab || !company) throw new AppError(404, "not_found", `Tab ${tabId} was not found.`);

  const settlementRow = latestSettlement(ctx, tabId, "completed") ?? latestSettlement(ctx, tabId);
  const settlement = settlementRow ? settlementDTO(db, settlementRow) : null;

  let sellers: SettlementLineDTO[];
  let feeCents: number;
  let chargedCents: number;
  let naiveFeeCents: number;
  if (settlement?.status === "completed") {
    sellers = settlement.lines;
    feeCents = settlement.paypalFeeCents;
    chargedCents = settlement.chargedCents;
    naiveFeeCents = settlement.naiveFeeCents;
  } else {
    const gross = unsettledGross(db, tabId);
    const plan = planSettlement(gross, row.carry_in_micros);
    chargedCents = plan.chargedCents;
    feeCents = estimatedFeeCents(plan.chargedCents);
    naiveFeeCents = plan.naiveFeeCents;
    const names = sellerNames(ctx, gross.map((g) => g.sellerId));
    sellers = allocateLines(gross, plan.chargedCents, feeCents)
      .map((line) => ({ ...line, sellerName: names.get(line.sellerId) ?? null }))
      .sort((a, b) => b.grossMicros - a.grossMicros || (a.sellerId < b.sellerId ? -1 : 1));
  }

  return {
    tab,
    company: companyDTO(company),
    settlement,
    sellers,
    voids: voidStats(db, tabId),
    fees: {
      paypalFeeCents: feeCents,
      effectiveRatePct: effectiveRatePct(feeCents, chargedCents),
      naiveFeeCents,
      savedCents: Math.max(0, naiveFeeCents - feeCents),
    },
    generatedAt: now,
  };
}

function sellerNames(ctx: SettlementContext, ids: string[]): Map<string, string> {
  const lookup = stmt(ctx.db, "SELECT name FROM sellers WHERE id = ?");
  return new Map(ids.map((id) => [id, (lookup.get(id) as { name: string } | undefined)?.name ?? id]));
}
