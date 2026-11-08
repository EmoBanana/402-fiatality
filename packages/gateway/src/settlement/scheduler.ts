/**
 * The tab lifecycle scheduler (SPEC §6.3), run every 30 s and right after the demo clock advances.
 *
 * For each authorized open tab (active, paused or frozen), in order:
 *   1. billable ≥ closeAtCents                      -> close now ("threshold")
 *   2. now ≥ expires_at − 1 h                         -> close now ("expiring", safety)
 *   3. reauthorization due and not done yet:
 *        small tab (billable < smallTabMinCents) on the early (day-4) slot
 *                                                    -> move reauth to day 25 and the charge to day 28
 *        else, unless the charge is due anyway       -> reauthorize for the hold amount (new 3-day honor)
 *   4. now ≥ close_at                                -> close ("scheduled")
 * Tabs left in `closing` by a crash are resumed. Pending payouts are refreshed.
 *
 * Sandbox caveat: PayPal refuses a reauthorization inside the real 3-day honor window, which the demo clock
 * skips. In sandbox mode the scheduler doesn't ask while that real window is open (the timeline still shows
 * the planned reauth); any failed reauthorization is logged and retried at most hourly. Either way the tab
 * keeps its original authorization and the charge happens on schedule.
 */
import { MICROS_PER_CENT } from "@p402/shared";
import { DAY_MS, HOUR_MS } from "../clock";
import { kvDelete, kvGet, kvSet, parseJson, stmt } from "../db/db";
import type { TabRow } from "../db/dto";
import { closeTab } from "./close";
import { authorizedRealTimeKey, HONOR_PERIOD_MS, realNow } from "./holds";
import { refreshPayouts } from "./payouts";
import {
  emitTab,
  errorFields,
  isLocked,
  loadTab,
  OPEN_TAB_STATUSES,
  type SettlementContext,
  tabPolicy,
  unsettledBillableMicros,
  withLock,
} from "./store";

/** Small tabs reauthorize on day 25 and are charged by day 28 (the authorization lives 29 days). */
export const SMALL_TAB_REAUTH_MS = 25 * DAY_MS;
export const SMALL_TAB_CLOSE_MS = 28 * DAY_MS;
/** Close this long before the authorization expires. */
export const EXPIRY_SAFETY_MS = HOUR_MS;
const REAUTH_RETRY_MS = HOUR_MS;

type Step = "none" | "closed" | "reauthorized" | "deferred";

const OPEN = new Set<string>(OPEN_TAB_STATUSES);
const reauthFailureKey = (tabId: string) => `settlement:reauth-failed:${tabId}`;
const reauthSkipNotedKey = (tabId: string) => `settlement:reauth-skip-noted:${tabId}`;

export async function tickOnce(ctx: SettlementContext): Promise<void> {
  const tabs = stmt(
    ctx.db,
    "SELECT id FROM tabs WHERE status IN ('active', 'paused', 'frozen', 'closing') ORDER BY created_at, id",
  ).all() as Array<{ id: string }>;
  for (const { id } of tabs) {
    try {
      await tickTab(ctx, id);
    } catch (err) {
      ctx.log.error({ tabId: id, ...errorFields(err) }, "scheduler step failed");
    }
  }
  try {
    await refreshPayouts(ctx);
  } catch (err) {
    ctx.log.error(errorFields(err), "payout refresh failed");
  }
}

async function tickTab(ctx: SettlementContext, tabId: string): Promise<void> {
  const tab = loadTab(ctx.db, tabId);
  if (!tab) return;
  if (tab.status === "closing") {
    if (!isLocked(ctx.db, `tab:${tabId}`)) await closeTab(ctx, tabId, "scheduled");
    return;
  }
  // A deferral changes the schedule, so look again (a big clock jump may make the new slot due too).
  for (let i = 0; i < 3; i++) {
    if ((await advanceTab(ctx, tabId)) !== "deferred") return;
  }
}

async function advanceTab(ctx: SettlementContext, tabId: string): Promise<Step> {
  const tab = loadTab(ctx.db, tabId);
  if (!tab || !OPEN.has(tab.status) || tab.authorized_at == null) return "none";
  const now = ctx.clock.now();
  const policy = tabPolicy(tab);
  // Billable as SPEC §6.4 defines it (accepted, unsettled spend + carry-in), the same figure the paywall uses.
  const billable = unsettledBillableMicros(ctx.db, tabId) + tab.carry_in_micros;

  if (billable >= policy.closeAtCents * MICROS_PER_CENT) {
    await closeTab(ctx, tabId, "threshold");
    return "closed";
  }
  if (tab.expires_at != null && now >= tab.expires_at - EXPIRY_SAFETY_MS) {
    await closeTab(ctx, tabId, "expiring");
    return "closed";
  }
  const closeDue = tab.close_at != null && now >= tab.close_at;
  if (tab.reauthorize_at != null && tab.reauthorized_at == null && now >= tab.reauthorize_at) {
    const earlySlot = tab.reauthorize_at < tab.authorized_at + SMALL_TAB_REAUTH_MS;
    if (earlySlot && billable < policy.smallTabMinCents * MICROS_PER_CENT) {
      deferSmallTab(ctx, tab);
      return "deferred";
    }
    if (!closeDue) {
      await reauthorizeTab(ctx, tabId);
      return "reauthorized";
    }
  }
  if (closeDue) {
    await closeTab(ctx, tabId, "scheduled");
    return "closed";
  }
  return "none";
}

/** Skip the day-4 reauthorization: reauthorize on day 25 and charge by day 28 instead. */
function deferSmallTab(ctx: SettlementContext, tab: TabRow): void {
  const authorizedAt = tab.authorized_at ?? tab.created_at;
  const reauthorizeAt = authorizedAt + SMALL_TAB_REAUTH_MS;
  let closeAt = authorizedAt + SMALL_TAB_CLOSE_MS;
  if (tab.expires_at != null) closeAt = Math.min(closeAt, tab.expires_at - EXPIRY_SAFETY_MS);
  stmt(ctx.db, "UPDATE tabs SET reauthorize_at = ?, close_at = ? WHERE id = ? AND reauthorized_at IS NULL").run(reauthorizeAt, closeAt, tab.id);
  emitTab(ctx, tab.id);
  ctx.log.info({ tabId: tab.id, reauthorizeAt, closeAt }, "small tab: reauthorization moved to day 25, charge to day 28");
}

export async function reauthorizeTab(ctx: SettlementContext, tabId: string): Promise<void> {
  await withLock(ctx.db, `tab:${tabId}`, async () => {
    const tab = loadTab(ctx.db, tabId);
    if (!tab || !OPEN.has(tab.status) || tab.reauthorized_at != null || !tab.authorization_id) return;
    const now = ctx.clock.now();
    const lastFailure = parseJson<{ at: number } | null>(kvGet(ctx.db, reauthFailureKey(tabId)), null);
    if (lastFailure && now - lastFailure.at < REAUTH_RETRY_MS) return;

    // The demo clock runs ahead of PayPal's: inside the real honor window the sandbox would refuse, so don't ask.
    const authorizedReal = Number(kvGet(ctx.db, authorizedRealTimeKey(tabId)) ?? 0);
    if (ctx.paypal.mode === "sandbox" && authorizedReal > 0 && realNow(ctx) - authorizedReal < HONOR_PERIOD_MS) {
      if (kvGet(ctx.db, reauthSkipNotedKey(tabId)) == null) {
        kvSet(ctx.db, reauthSkipNotedKey(tabId), "1");
        ctx.log.info({ tabId }, "sandbox: planned reauthorization skipped (PayPal's real 3-day honor window is still open); the charge uses the original authorization");
      }
      return;
    }

    try {
      const auth = await ctx.paypal.reauthorize(tab.authorization_id, tab.hold_cents, `reauth-${tabId}`);
      const at = ctx.clock.now();
      const expiresAt = tab.expires_at != null && auth.expiresAt != null ? Math.min(tab.expires_at, auth.expiresAt) : (tab.expires_at ?? auth.expiresAt);
      stmt(
        ctx.db,
        "UPDATE tabs SET reauth_authorization_id = ?, reauthorized_at = ?, honor_until = ?, expires_at = ? WHERE id = ?",
      ).run(auth.id, at, at + HONOR_PERIOD_MS, expiresAt, tabId);
      kvDelete(ctx.db, reauthFailureKey(tabId));
      emitTab(ctx, tabId);
      ctx.log.info({ tabId, authorizationId: auth.id }, "hold reauthorized");
    } catch (err) {
      kvSet(ctx.db, reauthFailureKey(tabId), JSON.stringify({ at: now }));
      const sandboxHint =
        ctx.paypal.mode === "sandbox" ? " (expected in sandbox when the demo clock skips PayPal's real 3-day honor window)" : "";
      ctx.log.warn({ tabId, ...errorFields(err) }, `reauthorization failed; keeping the original authorization${sandboxHint}`);
    }
  });
}
