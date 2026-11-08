/**
 * Settlement routes (SPEC §5.5, §6): PayPal return/cancel pages, the mock approval page, closing and
 * rescheduling tabs, statements, settlements, payouts and purchases. Gateway core registers this plugin with
 * `app.register(settlementRoutes, { ctx })` and owns the error handler (AppError / ZodError -> ApiErrorDTO),
 * the admin-token guard, CORS and helmet.
 */
import { formatCents, type PayoutDTO, type PayoutRunResultDTO, type PurchaseDTO, type SettlementDTO } from "@p402/shared";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { AppContext, RoutePlugin } from "../context";
import { stmt } from "../db/db";
import { payoutDTO, purchaseDTO, settlementDTO, type PayoutRow, type PurchaseRow, type SettlementRow } from "../db/dto";
import { approveMockOrder, getMockOrder } from "../paypal/mock";
import { cancelApproval, completeApproval, DEFAULT_PAYOUT_THRESHOLD_CENTS, rescheduleTab } from "../settlement";
import { checkReturnPage, type HtmlPage, messagePage, mockApprovalPage, returnPage } from "../settlement/pages";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Invalid id");
/** PayPal order ids (17 uppercase alphanumerics) and mock ids (MOCK-ORDER-...). */
const orderToken = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "Invalid PayPal token");
const httpUrl = z.url({ protocol: /^https?$/ }).max(2_048);
/** Product image: an http(s) URL, or a small inline image (the demo catalog ships SVG tiles as data: URIs). */
const imageUrl = z.union([httpUrl, z.string().max(16_384).regex(/^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/)]);

const idParams = z.object({ id });
const returnQuery = z.object({ kind: z.enum(["tab", "purchase", "check"]), ref: id, token: orderToken });
const listQuery = z.object({
  tabId: id.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
const scheduleBody = z
  .object({
    closeAt: z.number().int().positive().optional(),
    reauthorizeAt: z.number().int().positive().optional(),
  })
  .refine((b) => b.closeAt !== undefined || b.reauthorizeAt !== undefined, { message: "Send closeAt and/or reauthorizeAt (epoch ms)." });
const payoutRunBody = z.object({ thresholdCents: z.number().int().min(1).max(100_000_000).optional() });
const purchaseBody = z.object({
  tabId: id,
  title: z.string().trim().min(1).max(127),
  amountCents: z.number().int().min(1).max(1_000_000),
  merchant: z.string().trim().min(1).max(127).optional(),
  productUrl: httpUrl.optional(),
  imageUrl: imageUrl.optional(),
  researchCostMicros: z.number().int().min(0).max(1_000_000_000_000),
  reasoning: z.string().trim().max(4_000).optional(),
});
const mockDecision = z.object({ token: orderToken, action: z.enum(["approve", "cancel"]) });

/** PayPal appends `token` (order id) and `PayerID` to the return URL; the mock does the same. */
const MOCK_PAYER_ID = "MOCKPAYER01";

function sendPage(reply: FastifyReply, status: number, page: HtmlPage): FastifyReply {
  return reply
    .code(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("content-security-policy", page.csp)
    // The popup must keep window.opener to report back to the console that opened it.
    .header("cross-origin-opener-policy", "unsafe-none")
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .send(page.html);
}

function withParams(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
  return u.toString();
}

function consoleUrl(ctx: AppContext, kind: "tab" | "purchase", ref: string): string {
  const base = `${ctx.config.webBaseUrl}/console`;
  if (kind === "tab") return `${base}?tab=${encodeURIComponent(ref)}`;
  const purchase = stmt(ctx.db, "SELECT tab_id FROM purchases WHERE id = ?").get(ref) as { tab_id: string | null } | undefined;
  return purchase?.tab_id ? `${base}?tab=${encodeURIComponent(purchase.tab_id)}` : base;
}

function payoutMessage(payout: PayoutDTO | null, thresholdCents: number): string {
  if (!payout) return `No seller is owed at least ${formatCents(thresholdCents)} yet.`;
  const sellers = `${payout.items.length} ${payout.items.length === 1 ? "seller" : "sellers"}`;
  const amounts = `${formatCents(payout.totalCents)} (PayPal fees ${formatCents(payout.feeCents)})`;
  switch (payout.status) {
    case "success":
      return `Paid ${sellers} ${amounts}.`;
    case "pending":
      return `Sent ${amounts} to ${sellers}; PayPal is processing the batch.`;
    case "partial":
      return `Paid part of ${amounts}; some items failed and their balances were restored.`;
    default:
      return `PayPal rejected the payout; balances were restored.${payout.error ? ` ${payout.error}` : ""}`;
  }
}

export const settlementRoutes: RoutePlugin = async (app, { ctx }) => {
  // The mock approval form posts urlencoded fields (scoped to this plugin).
  if (!app.hasContentTypeParser("application/x-www-form-urlencoded")) {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 4_096 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }

  const badLink = () => messagePage("Invalid PayPal link", "This PayPal link is incomplete or malformed. Start again from the console.");
  const mockOnly = () => messagePage("Not available", "The mock PayPal page only exists when PAYPAL_MODE=mock.");

  // ------------------------------------------------------------ PayPal redirects (HTML)

  app.get("/paypal/return", async (req, reply) => {
    const query = returnQuery.safeParse(req.query);
    if (!query.success) return sendPage(reply, 400, badLink());
    const { kind, ref, token } = query.data;
    if (kind === "check") return sendPage(reply, 200, checkReturnPage("approved"));
    const message = await completeApproval(ctx, kind, ref, token);
    return sendPage(
      reply,
      200,
      returnPage({ message, consoleUrl: consoleUrl(ctx, kind, ref), origins: [ctx.config.webBaseUrl, ctx.config.publicBaseUrl] }),
    );
  });

  app.get("/paypal/cancel", async (req, reply) => {
    const query = returnQuery.safeParse(req.query);
    if (!query.success) return sendPage(reply, 400, badLink());
    const { kind, ref, token } = query.data;
    if (kind === "check") return sendPage(reply, 200, checkReturnPage("cancelled"));
    const message = await cancelApproval(ctx, kind, ref, token);
    return sendPage(
      reply,
      200,
      returnPage({ message, consoleUrl: consoleUrl(ctx, kind, ref), origins: [ctx.config.webBaseUrl, ctx.config.publicBaseUrl] }),
    );
  });

  app.get("/paypal/mock/approve", async (req, reply) => {
    if (ctx.paypal.mode !== "mock") return sendPage(reply, 404, mockOnly());
    const query = z.object({ token: orderToken }).safeParse(req.query);
    if (!query.success) return sendPage(reply, 400, badLink());
    const order = getMockOrder(ctx.db, query.data.token);
    if (!order) return sendPage(reply, 404, messagePage("Unknown order", "This mock PayPal order does not exist."));
    const continueUrl = order.status === "PAYER_ACTION_REQUIRED" ? null : withParams(order.returnUrl, { token: order.id, PayerID: MOCK_PAYER_ID });
    return sendPage(reply, 200, mockApprovalPage({ order, formAction: `${ctx.config.publicBaseUrl}/paypal/mock/approve`, continueUrl }));
  });

  app.post("/paypal/mock/approve", async (req, reply) => {
    if (ctx.paypal.mode !== "mock") return sendPage(reply, 404, mockOnly());
    const body = mockDecision.safeParse(req.body);
    if (!body.success) return sendPage(reply, 400, badLink());
    const order = getMockOrder(ctx.db, body.data.token);
    if (!order) return sendPage(reply, 404, messagePage("Unknown order", "This mock PayPal order does not exist."));
    if (body.data.action === "cancel") return reply.redirect(withParams(order.cancelUrl, { token: order.id }), 303);
    approveMockOrder(ctx.db, order.id);
    return reply.redirect(withParams(order.returnUrl, { token: order.id, PayerID: MOCK_PAYER_ID }), 303);
  });

  // ------------------------------------------------------------ tabs

  app.post("/api/tabs/:id/close", async (req): Promise<SettlementDTO> => {
    const { id: tabId } = idParams.parse(req.params);
    return ctx.settlement.closeTab(tabId, "manual");
  });

  app.patch("/api/tabs/:id/schedule", async (req) => {
    const { id: tabId } = idParams.parse(req.params);
    return rescheduleTab(ctx, tabId, scheduleBody.parse(req.body ?? {}));
  });

  app.get("/api/tabs/:id/statement", async (req) => {
    const { id: tabId } = idParams.parse(req.params);
    return ctx.settlement.statement(tabId);
  });

  // ------------------------------------------------------------ settlements & payouts

  app.get("/api/settlements", async (req): Promise<SettlementDTO[]> => {
    const { tabId, limit } = listQuery.parse(req.query);
    const rows = stmt(
      ctx.db,
      "SELECT * FROM settlements WHERE (@tabId IS NULL OR tab_id = @tabId) ORDER BY created_at DESC, rowid DESC LIMIT @limit",
    ).all({ tabId: tabId ?? null, limit }) as SettlementRow[];
    return rows.map((row) => settlementDTO(ctx.db, row));
  });

  app.get("/api/payouts", async (req): Promise<PayoutDTO[]> => {
    const { limit } = listQuery.parse(req.query);
    const rows = stmt(ctx.db, "SELECT * FROM payouts ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit) as PayoutRow[];
    return rows.map((row) => payoutDTO(ctx.db, row));
  });

  app.post("/api/payouts/run", async (req): Promise<PayoutRunResultDTO> => {
    const { thresholdCents = DEFAULT_PAYOUT_THRESHOLD_CENTS } = payoutRunBody.parse(req.body ?? {});
    const payout = await ctx.settlement.runPayouts({ thresholdCents });
    return { payout, message: payoutMessage(payout, thresholdCents) };
  });

  // ------------------------------------------------------------ purchases

  app.get("/api/purchases", async (req): Promise<PurchaseDTO[]> => {
    const { tabId, limit } = listQuery.parse(req.query);
    const rows = stmt(
      ctx.db,
      "SELECT * FROM purchases WHERE (@tabId IS NULL OR tab_id = @tabId) ORDER BY created_at DESC, rowid DESC LIMIT @limit",
    ).all({ tabId: tabId ?? null, limit }) as PurchaseRow[];
    return rows.map(purchaseDTO);
  });

  app.post("/api/purchases", async (req, reply) => {
    const purchase = await ctx.settlement.proposePurchase(purchaseBody.parse(req.body));
    return reply.code(201).send(purchase);
  });

  app.post("/api/purchases/:id/checkout", async (req) => {
    const { id: purchaseId } = idParams.parse(req.params);
    return ctx.settlement.checkoutPurchase(purchaseId);
  });
};
