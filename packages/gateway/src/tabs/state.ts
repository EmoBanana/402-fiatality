/** Tab status changes made by the gateway core (pause, resume, freeze), each announced with `tab.updated`. */
import type { TabDTO, TabStatus } from "@p402/shared";
import type { AppContext } from "../context";
import { stmt } from "../db/db";
import { getTabDTO, type TabRow } from "../db/dto";

export function getTabRow(ctx: AppContext, tabId: string): TabRow | undefined {
  return stmt(ctx.db, "SELECT * FROM tabs WHERE id = ?").get(tabId) as TabRow | undefined;
}

/**
 * Compare-and-set: move the tab to `to` only if it is currently in one of `from`. Returns true when it moved.
 * Call inside a transaction when other rows change with it, then `announceTab` after commit.
 */
export function transitionTab(ctx: AppContext, tabId: string, from: TabStatus[], to: TabStatus): boolean {
  const placeholders = from.map(() => "?").join(", ");
  return stmt(ctx.db, `UPDATE tabs SET status = ? WHERE id = ? AND status IN (${placeholders})`).run(to, tabId, ...from).changes > 0;
}

/** Emit `tab.updated` with the current DTO. */
export function announceTab(ctx: AppContext, tabId: string): TabDTO | null {
  const dto = getTabDTO(ctx.db, tabId, ctx.clock.now());
  if (dto) ctx.bus.emit("tab.updated", dto);
  return dto;
}

/** Close every open or reviewing alarm of a tab (a human or a verdict settled it). */
export function resolveTabAlarms(ctx: AppContext, tabId: string, opts: { exceptKinds?: string[] } = {}): void {
  const except = opts.exceptKinds ?? [];
  const placeholders = except.map(() => "?").join(", ");
  stmt(
    ctx.db,
    `UPDATE alarms SET status = 'resolved' WHERE tab_id = ? AND status IN ('open', 'reviewing')${except.length ? ` AND kind NOT IN (${placeholders})` : ""}`,
  ).run(tabId, ...except);
}
