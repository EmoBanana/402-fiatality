/**
 * Opening a tab (SPEC §6.2): the AUTHORIZE order, the payer's approval or cancellation, and the
 * demo-only rescheduling of the planned reauthorization and charge.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  newId,
  policySchema,
  type PaypalReturnMessage,
  type TabCreateDTO,
  type TabCreatedDTO,
  type TabDTO,
  type TabScheduleDTO,
} from "@p402/shared";
import { DAY_MS } from "../clock";
import { AppError } from "../context";
import { type Db, kvSet, stmt, tx } from "../db/db";
import { getTabDTO } from "../db/dto";
import { PaypalError } from "../paypal/errors";
import {
  addCarry,
  emitTab,
  loadTab,
  OPEN_TAB_STATUSES,
  requireTab,
  type SettlementContext,
  tabPolicy,
  takeCarry,
  withLock,
} from "./store";

export const HOLD_DESCRIPTION = "Agent spending tab";
export const SOFT_DESCRIPTOR = "PP402 AGENT TAB";
export const BRAND_NAME = "PayPal 402";

/** PayPal: the hold is honored for 3 days, reauthorized once (day 4), valid 29 days. */
export const HONOR_PERIOD_MS = 3 * DAY_MS;
export const REAUTHORIZE_AFTER_MS = 4 * DAY_MS;
export const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;

/** kv key: when PayPal authorized the tab's hold, in real epoch ms (the demo clock can run ahead of it). */
export const authorizedRealTimeKey = (tabId: string) => `settlement:authorized-real:${tabId}`;

/** Real time: the gateway clock without the demo fast-forward. PayPal lives in this time. */
export const realNow = (ctx: Pick<SettlementContext, "clock">) => ctx.clock.now() - ctx.clock.offsetMs();

export function newEnrollToken(): string {
  return `tok_${randomBytes(32).toString("base64url")}`;
}

/** Stored in tabs.enroll_token_hash; gateway core verifies agent enrollment against it. */
export function hashEnrollToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type ApprovalKind = "tab" | "purchase";

export function paypalReturnUrls(publicBaseUrl: string, kind: ApprovalKind, ref: string): { returnUrl: string; cancelUrl: string } {
  const query = `kind=${kind}&ref=${encodeURIComponent(ref)}`;
  return { returnUrl: `${publicBaseUrl}/paypal/return?${query}`, cancelUrl: `${publicBaseUrl}/paypal/cancel?${query}` };
}

export function returnMessage(
  kind: ApprovalKind,
  ref: string,
  status: PaypalReturnMessage["status"],
  message?: string,
): PaypalReturnMessage {
  return { type: "p402:paypal-return", kind, ref, status, ...(message ? { message } : {}) };
}

function openTabOf(db: Db, companyId: string): { id: string; status: string } | null {
  return (
    (stmt(
      db,
      `SELECT id, status FROM tabs WHERE company_id = ? AND status IN ('active', 'paused', 'frozen', 'closing')
        ORDER BY created_at DESC LIMIT 1`,
    ).get(companyId) as { id: string; status: string } | undefined) ?? null
  );
}

function assertNoOpenTab(db: Db, companyId: string): void {
  const open = openTabOf(db, companyId);
  if (open) {
    throw new AppError(
      409,
      "tab_already_open",
      `This company already has an open tab (${open.id}). Close it before opening another: one hold per company.`,
      { tabId: open.id, status: open.status },
    );
  }
}

/** Cancel a tab PayPal never authorized and give its carry-in back to the company. Inside a transaction. */
function cancelUnapproved(db: Db, tabId: string, now: number): boolean {
  const tab = loadTab(db, tabId);
  if (!tab || tab.status !== "pending_approval") return false;
  stmt(db, "UPDATE tabs SET status = 'cancelled', closed_at = ?, carry_in_micros = 0 WHERE id = ?").run(now, tabId);
  addCarry(db, tab.company_id, tab.carry_in_micros);
  return true;
}

/**
 * POST /api/tabs (input validated, policy normalized by gateway core). Places the PayPal hold as an
 * AUTHORIZE order and stores the tab as pending_approval. A company keeps one open tab: an authorized one
 * blocks with 409 `tab_already_open`; abandoned unapproved ones are cancelled.
 */
export async function createHold(ctx: SettlementContext, input: TabCreateDTO): Promise<TabCreatedDTO> {
  const { db } = ctx;
  const policy = policySchema.parse(input.policy);
  const company = stmt(db, "SELECT id FROM companies WHERE id = ?").get(input.companyId);
  if (!company) throw new AppError(404, "not_found", `Company ${input.companyId} was not found.`);
  assertNoOpenTab(db, input.companyId);

  const tabId = newId("tab");
  const order = await ctx.paypal.createAuthorizeOrder({
    referenceId: tabId,
    amountCents: policy.holdCents,
    description: HOLD_DESCRIPTION,
    softDescriptor: SOFT_DESCRIPTOR,
    brandName: BRAND_NAME,
    ...paypalReturnUrls(ctx.config.publicBaseUrl, "tab", tabId),
    requestId: `hold-${tabId}`,
  });
  if (!order.approveUrl) {
    throw new PaypalError({ operation: "create hold order", paypalName: "INVALID_RESPONSE", message: "PayPal returned no approval link" });
  }
  const approveUrl = order.approveUrl;

  const enrollToken = newEnrollToken();
  const now = ctx.clock.now();
  const cancelled = tx(db, () => {
    assertNoOpenTab(db, input.companyId);
    const stale = (
      stmt(db, "SELECT id FROM tabs WHERE company_id = ? AND status = 'pending_approval'").all(input.companyId) as Array<{ id: string }>
    ).filter((t) => cancelUnapproved(db, t.id, now));
    const carryIn = takeCarry(db, input.companyId);
    stmt(
      db,
      `INSERT INTO tabs (id, company_id, label, status, policy, policy_text, hold_cents, enroll_token_hash,
                         paypal_order_id, approve_url, carry_in_micros, created_at)
       VALUES (?, ?, ?, 'pending_approval', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      tabId,
      input.companyId,
      input.label ?? null,
      JSON.stringify(policy),
      input.policyText ?? null,
      policy.holdCents,
      hashEnrollToken(enrollToken),
      order.id,
      approveUrl,
      carryIn,
      now,
    );
    return stale.map((t) => t.id);
  });

  for (const id of cancelled) emitTab(ctx, id);
  emitTab(ctx, tabId);
  ctx.log.info({ tabId, companyId: input.companyId, orderId: order.id, holdCents: policy.holdCents }, "hold created");
  const tab = getTabDTO(db, tabId, ctx.clock.now());
  if (!tab) throw new AppError(500, "internal_error", "The new tab could not be read back.");
  return { tab, enrollToken, orderId: order.id, approveUrl };
}

/** /paypal/return?kind=tab: authorize the approved hold. Idempotent (reloads, double redirects). */
export async function approveTab(ctx: SettlementContext, tabId: string, orderId: string): Promise<PaypalReturnMessage> {
  return withLock(ctx.db, `tab:${tabId}`, async () => {
    const tab = loadTab(ctx.db, tabId);
    if (!tab) return returnMessage("tab", tabId, "failed", "This tab does not exist.");
    if (tab.paypal_order_id !== orderId) return returnMessage("tab", tabId, "failed", "This PayPal approval does not belong to this tab.");
    if (tab.status === "cancelled") return returnMessage("tab", tabId, "cancelled", "This tab was cancelled before PayPal approved it.");
    if (tab.status !== "pending_approval") return returnMessage("tab", tabId, "approved");

    let auth;
    try {
      auth = await ctx.paypal.authorizeOrder(orderId, `authorize-${tabId}`);
    } catch (err) {
      ctx.log.warn({ tabId, orderId }, "hold authorization failed");
      return returnMessage("tab", tabId, "failed", err instanceof Error ? err.message : "PayPal could not authorize the hold.");
    }
    if (auth.status !== "CREATED" && auth.status !== "PENDING") {
      ctx.log.warn({ tabId, orderId, authorizationId: auth.id, status: auth.status }, "hold authorization not usable");
      return returnMessage("tab", tabId, "failed", `PayPal returned the authorization as ${auth.status}.`);
    }

    const now = ctx.clock.now();
    const policy = tabPolicy(tab);
    stmt(
      ctx.db,
      `UPDATE tabs SET status = 'active', authorization_id = ?, authorized_at = ?, honor_until = ?, expires_at = ?,
                       reauthorize_at = ?, close_at = ?
        WHERE id = ? AND status = 'pending_approval'`,
    ).run(
      auth.id,
      now,
      now + HONOR_PERIOD_MS,
      auth.expiresAt ?? now + AUTHORIZATION_VALIDITY_MS,
      now + REAUTHORIZE_AFTER_MS,
      now + policy.closeAfterDays * DAY_MS,
      tabId,
    );
    // Real (not demo-clock) time, so the scheduler knows when PayPal itself will accept a reauthorization.
    kvSet(ctx.db, authorizedRealTimeKey(tabId), String(realNow(ctx)));
    emitTab(ctx, tabId);
    ctx.log.info({ tabId, authorizationId: auth.id }, "hold authorized");
    return returnMessage("tab", tabId, "approved");
  });
}

/** /paypal/cancel?kind=tab: the payer backed out on PayPal. Idempotent. */
export async function cancelTab(ctx: SettlementContext, tabId: string, orderId: string): Promise<PaypalReturnMessage> {
  return withLock(ctx.db, `tab:${tabId}`, async () => {
    const tab = loadTab(ctx.db, tabId);
    if (!tab) return returnMessage("tab", tabId, "failed", "This tab does not exist.");
    if (tab.paypal_order_id !== orderId) return returnMessage("tab", tabId, "failed", "This PayPal approval does not belong to this tab.");
    if (tab.status === "pending_approval") {
      tx(ctx.db, () => cancelUnapproved(ctx.db, tabId, ctx.clock.now()));
      emitTab(ctx, tabId);
      ctx.log.info({ tabId }, "hold approval cancelled");
      return returnMessage("tab", tabId, "cancelled");
    }
    if (tab.status === "cancelled") return returnMessage("tab", tabId, "cancelled");
    return returnMessage("tab", tabId, "approved", "The hold was already approved.");
  });
}

const formatDay = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";

/**
 * PATCH /api/tabs/:id/schedule (demo only: Bryntum drag-to-reschedule). The reauthorization must fall
 * after the 3-day honor window and before expiry and can't move once done; the charge must fall after the
 * authorization and no later than its expiry. A time in the past is picked up by the next tick.
 */
export async function rescheduleTab(ctx: SettlementContext, tabId: string, input: TabScheduleDTO): Promise<TabDTO> {
  if (!ctx.config.demo) throw new AppError(403, "demo_only", "Rescheduling a tab is only available in demo mode (DEMO_MODE=1).");
  if (input.closeAt === undefined && input.reauthorizeAt === undefined) {
    throw new AppError(400, "invalid_request", "Send closeAt and/or reauthorizeAt (epoch ms).");
  }
  return withLock(ctx.db, `tab:${tabId}`, async () => {
    const tab = requireTab(ctx.db, tabId);
    if (!(OPEN_TAB_STATUSES as readonly string[]).includes(tab.status) || tab.authorized_at == null) {
      throw new AppError(409, "tab_not_open", `Only an authorized, open tab can be rescheduled (this one is ${tab.status}).`);
    }
    const authorizedAt = tab.authorized_at;
    const expiresAt = tab.expires_at ?? authorizedAt + AUTHORIZATION_VALIDITY_MS;
    let reauthorizeAt = tab.reauthorize_at;
    let closeAt = tab.close_at;

    if (input.reauthorizeAt !== undefined) {
      if (tab.reauthorized_at != null) {
        throw new AppError(409, "already_reauthorized", "This hold was already reauthorized (PayPal allows it once).");
      }
      const earliest = authorizedAt + HONOR_PERIOD_MS;
      if (input.reauthorizeAt < earliest) {
        throw new AppError(400, "invalid_request", `PayPal reauthorizes only after the 3-day honor window (from ${formatDay(earliest)}).`);
      }
      if (input.reauthorizeAt >= expiresAt) {
        throw new AppError(400, "invalid_request", `The reauthorization must happen before the hold expires (${formatDay(expiresAt)}).`);
      }
      reauthorizeAt = input.reauthorizeAt;
    }
    if (input.closeAt !== undefined) {
      if (input.closeAt <= authorizedAt) throw new AppError(400, "invalid_request", "The charge must come after the hold was authorized.");
      if (input.closeAt > expiresAt) {
        throw new AppError(400, "invalid_request", `The charge must happen before the hold expires (${formatDay(expiresAt)}).`);
      }
      closeAt = input.closeAt;
    }

    stmt(ctx.db, "UPDATE tabs SET reauthorize_at = ?, close_at = ? WHERE id = ?").run(reauthorizeAt, closeAt, tabId);
    emitTab(ctx, tabId);
    const dto = getTabDTO(ctx.db, tabId, ctx.clock.now());
    if (!dto) throw new AppError(404, "not_found", `Tab ${tabId} was not found.`);
    return dto;
  });
}
