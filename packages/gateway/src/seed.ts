/**
 * Demo seeding (DEMO_MODE=1), idempotent: the "Northwind Research" company and the demo sellers from
 * `ctx.demoSellers(config)`, registered through the same validation as POST /api/sellers. A seller that fails
 * (e.g. the real Channel3 host can't be resolved offline) is logged and skipped.
 */
import type { AppContext } from "./context";
import { stmt } from "./db/db";
import { registerSeller } from "./sellers/registry";

export const DEMO_COMPANY = { id: "co_northwind", name: "Northwind Research" } as const;

export interface SeedResult {
  sellers: string[];
  failed: string[];
}

export async function seedDemo(ctx: AppContext): Promise<SeedResult> {
  stmt(ctx.db, "INSERT OR IGNORE INTO companies (id, name, created_at) VALUES (?, ?, ?)").run(DEMO_COMPANY.id, DEMO_COMPANY.name, ctx.clock.now());
  const result: SeedResult = { sellers: [], failed: [] };
  let listings: unknown[] = [];
  try {
    listings = ctx.demoSellers(ctx.config) ?? [];
  } catch (err) {
    ctx.log.warn({ err }, "demo sellers are unavailable");
  }
  for (const listing of listings) {
    const id = (listing as { id?: unknown }).id;
    try {
      const seller = await registerSeller(ctx, listing, { upsert: true });
      result.sellers.push(seller.id);
    } catch (err) {
      result.failed.push(String(id));
      ctx.log.warn({ sellerId: id, reason: (err as Error).message }, "demo seller was not seeded");
    }
  }
  return result;
}
