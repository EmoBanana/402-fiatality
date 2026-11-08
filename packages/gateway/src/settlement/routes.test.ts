/** src/routes/settlement.ts through Fastify's inject(), with a minimal stand-in for gateway core's error handler. */
import { normalizePolicy, type PayoutRunResultDTO, type PurchaseCheckoutDTO, type PurchaseDTO, type SettlementDTO, type StatementDTO, type TabDTO } from "@p402/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { DAY_MS } from "../clock";
import { AppError, type AppContext } from "../context";
import { stmt } from "../db/db";
import { settlementRoutes } from "../routes/settlement";
import { escapeHtml, returnPage } from "./pages";
import { addVouchers, COMPANY_ID, createHarness, openTab, setBalance, T0 } from "./testing";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function build(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((err: Error & { statusCode?: number; issues?: unknown }, _req, reply) => {
    if (err instanceof AppError) return reply.code(err.status).send({ error: err.code, message: err.message, details: err.details });
    if (err.name === "ZodError") return reply.code(400).send({ error: "invalid_request", message: "Invalid request", details: err.issues });
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    return reply.code(status).send({ error: "error", message: err.message });
  });
  await app.register(settlementRoutes, { ctx });
  await app.ready();
  apps.push(app);
  return app;
}

const pathOf = (url: string) => {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
};

describe("PayPal pages", () => {
  it("runs the mock approval flow end to end and stays idempotent", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });

    const page = await app.inject({ method: "GET", url: pathOf(created.approveUrl) });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/style-src 'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("form-action 'self' http://localhost:4020");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.body).toContain("Mock PayPal (offline demo)");
    expect(page.body).toContain("$50.00");
    expect(page.body).not.toMatch(/#0070ba|#003087|#ffc439/i); // no PayPal brand colors

    const approve = await app.inject({
      method: "POST",
      url: "/paypal/mock/approve",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${encodeURIComponent(created.orderId)}&action=approve`,
    });
    expect(approve.statusCode).toBe(303);
    const location = String(approve.headers.location);
    expect(location).toBe(
      `http://localhost:4020/paypal/return?kind=tab&ref=${created.tab.id}&token=${created.orderId}&PayerID=MOCKPAYER01`,
    );

    const returned = await app.inject({ method: "GET", url: pathOf(location) });
    expect(returned.statusCode).toBe(200);
    expect(returned.headers["content-security-policy"]).toContain("form-action 'none'");
    expect(returned.headers["referrer-policy"]).toBe("no-referrer");
    expect(returned.body).toContain('"type":"p402:paypal-return"');
    expect(returned.body).toContain('"status":"approved"');
    expect(returned.body).toContain('["http://localhost:5173","http://localhost:4020"]');
    expect(returned.body).toContain("window.opener.postMessage");
    expect(returned.body).toContain(`http://localhost:5173/console?tab=${created.tab.id}`);
    expect((stmt(h.ctx.db, "SELECT status FROM tabs WHERE id = ?").get(created.tab.id) as { status: string }).status).toBe("active");

    const reload = await app.inject({ method: "GET", url: pathOf(location) });
    expect(reload.body).toContain('"status":"approved"');
    expect(h.calls.authorizeOrder).toBe(1);

    const again = await app.inject({ method: "GET", url: pathOf(created.approveUrl) });
    expect(again.body).toContain("Already approved");
  });

  it("cancels through the mock page", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const created = await h.ctx.settlement.createHold({ companyId: COMPANY_ID, policy: normalizePolicy() });
    const cancel = await app.inject({
      method: "POST",
      url: "/paypal/mock/approve",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${created.orderId}&action=cancel`,
    });
    expect(cancel.statusCode).toBe(303);
    expect(String(cancel.headers.location)).toBe(`http://localhost:4020/paypal/cancel?kind=tab&ref=${created.tab.id}&token=${created.orderId}`);
    const page = await app.inject({ method: "GET", url: pathOf(String(cancel.headers.location)) });
    expect(page.body).toContain("Hold cancelled");
    expect(page.body).toContain('"status":"cancelled"');
    expect((stmt(h.ctx.db, "SELECT status FROM tabs WHERE id = ?").get(created.tab.id) as { status: string }).status).toBe("cancelled");
  });

  it("rejects malformed links without echoing them and escapes what it shows", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const evil = encodeURIComponent('<script>alert("x")</script>');
    const bad = await app.inject({ method: "GET", url: `/paypal/return?kind=tab&ref=${evil}&token=ABC` });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toContain("<script>alert");
    expect((await app.inject({ method: "GET", url: "/paypal/return?kind=evil&ref=tab_1&token=ABC" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/paypal/mock/approve?token=MOCK-ORDER-NOPE" })).statusCode).toBe(404);
    const unknown = await app.inject({ method: "GET", url: "/paypal/return?kind=tab&ref=tab_missing&token=ABC" });
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toContain('"status":"failed"');

    const page = returnPage({
      message: { type: "p402:paypal-return", kind: "tab", ref: "tab_1", status: "failed", message: '</script><img src=x onerror="alert(1)">' },
      consoleUrl: 'http://localhost:5173/console?tab="><script>',
      origins: ["http://localhost:5173", "not a url"],
    });
    expect(page.html).not.toContain("</script><img");
    expect(page.html).not.toContain('"><script>');
    expect(page.html).toContain("\\u003c/script\\u003e");
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("serves a friendly page for the check-paypal script and hides the mock page outside mock mode", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const check = await app.inject({ method: "GET", url: "/paypal/return?kind=check&ref=check&token=5O190127TN364715T&PayerID=X" });
    expect(check.statusCode).toBe(200);
    expect(check.body).toContain("npm run check:paypal");

    h.ctx.paypal = { ...h.ctx.paypal, mode: "sandbox" };
    expect((await app.inject({ method: "GET", url: "/paypal/mock/approve?token=MOCK-ORDER-X" })).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/paypal/mock/approve",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "token=MOCK-ORDER-X&action=approve",
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("settlement API", () => {
  it("closes a tab and lists settlements and the statement", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const { tabId } = await openTab(h.ctx);
    addVouchers(h.ctx, tabId, "channel3", 1_000, 5_000);

    const closed = await app.inject({ method: "POST", url: `/api/tabs/${tabId}/close` });
    expect(closed.statusCode).toBe(200);
    const settlement = closed.json<SettlementDTO>();
    expect(settlement).toMatchObject({ tabId, status: "completed", chargedCents: 500 });

    const list = await app.inject({ method: "GET", url: `/api/settlements?tabId=${tabId}` });
    expect(list.json<SettlementDTO[]>().map((s) => s.id)).toEqual([settlement.id]);
    expect((await app.inject({ method: "GET", url: "/api/settlements?tabId=tab_other" })).json()).toEqual([]);

    const statement = await app.inject({ method: "GET", url: `/api/tabs/${tabId}/statement` });
    expect(statement.json<StatementDTO>()).toMatchObject({ tab: { id: tabId, status: "settled" }, settlement: { id: settlement.id } });

    expect((await app.inject({ method: "POST", url: "/api/tabs/tab_missing/close" })).json()).toMatchObject({ error: "not_found" });
    expect((await app.inject({ method: "POST", url: "/api/tabs/bad id!/close" })).statusCode).toBe(400);
  });

  it("reschedules a tab in demo mode with ordering checks", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const { tabId } = await openTab(h.ctx);
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/api/tabs/${tabId}/schedule`, payload: payload as object });

    const moved = await patch({ closeAt: T0 + 2 * DAY_MS, reauthorizeAt: T0 + 5 * DAY_MS });
    expect(moved.statusCode).toBe(200);
    expect(moved.json<TabDTO>()).toMatchObject({ id: tabId, closeAt: T0 + 2 * DAY_MS, reauthorizeAt: T0 + 5 * DAY_MS });
    expect(h.events.filter((e) => e.type === "tab.updated").at(-1)?.data).toMatchObject({ closeAt: T0 + 2 * DAY_MS });

    expect((await patch({ reauthorizeAt: T0 + DAY_MS })).json()).toMatchObject({ error: "invalid_request" });
    expect((await patch({ closeAt: T0 - 1 })).statusCode).toBe(400);
    expect((await patch({ closeAt: T0 + 30 * DAY_MS })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ closeAt: "tomorrow" })).statusCode).toBe(400);

    // Once reauthorized, only the charge can move.
    addVouchers(h.ctx, tabId, "channel3", 2_400, 5_000); // $12: not a small tab
    await patch({ closeAt: T0 + 7 * DAY_MS });
    h.advance(5 * DAY_MS);
    await h.ctx.settlement.tick();
    expect((await patch({ reauthorizeAt: T0 + 6 * DAY_MS })).json()).toMatchObject({ error: "already_reauthorized" });
    expect((await patch({ closeAt: T0 + 6 * DAY_MS })).statusCode).toBe(200);

    const prod = createHarness({ config: { demo: false, adminToken: "secret-admin" } });
    const prodApp = await build(prod.ctx);
    const prodTab = await openTab(prod.ctx);
    const denied = await prodApp.inject({ method: "PATCH", url: `/api/tabs/${prodTab.tabId}/schedule`, payload: { closeAt: T0 + DAY_MS } });
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ error: "demo_only" });
  });

  it("runs payouts and lists them", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const none = await app.inject({ method: "POST", url: "/api/payouts/run", payload: {} });
    expect(none.json<PayoutRunResultDTO>()).toEqual({ payout: null, message: "No seller is owed at least $10.00 yet." });

    setBalance(h.ctx, "channel3", 2_500_000);
    const run = await app.inject({ method: "POST", url: "/api/payouts/run", payload: { thresholdCents: 100 } });
    const result = run.json<PayoutRunResultDTO>();
    expect(result.payout).toMatchObject({ status: "success", totalCents: 225, feeCents: 25 });
    expect(result.message).toBe("Paid 1 seller $2.25 (PayPal fees $0.25).");
    const noBody = await app.inject({ method: "POST", url: "/api/payouts/run" });
    expect(noBody.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/payouts/run", payload: { thresholdCents: -5 } })).statusCode).toBe(400);

    const list = await app.inject({ method: "GET", url: "/api/payouts" });
    expect(list.json<unknown[]>()).toHaveLength(1);
  });

  it("takes a purchase proposal through checkout and PayPal approval", async () => {
    const h = createHarness();
    const app = await build(h.ctx);
    const { tabId } = await openTab(h.ctx);

    const invalid = await app.inject({ method: "POST", url: "/api/purchases", payload: { tabId, title: "", amountCents: -1, researchCostMicros: 0 } });
    expect(invalid.statusCode).toBe(400);
    const badUrl = await app.inject({
      method: "POST",
      url: "/api/purchases",
      payload: { tabId, title: "x", amountCents: 100, researchCostMicros: 0, productUrl: "javascript:alert(1)" },
    });
    expect(badUrl.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/api/purchases",
      payload: { tabId, title: "Standing desk", amountCents: 32_900, merchant: "Example Desks", researchCostMicros: 412_000 },
    });
    expect(created.statusCode).toBe(201);
    const purchase = created.json<PurchaseDTO>();
    expect(purchase).toMatchObject({ status: "proposed", title: "Standing desk" });
    expect((await app.inject({ method: "GET", url: `/api/purchases?tabId=${tabId}` })).json<PurchaseDTO[]>().map((p) => p.id)).toEqual([purchase.id]);

    const checkout = (await app.inject({ method: "POST", url: `/api/purchases/${purchase.id}/checkout` })).json<PurchaseCheckoutDTO>();
    expect(checkout.purchase.status).toBe("awaiting_approval");
    const mockPage = await app.inject({ method: "GET", url: pathOf(checkout.approveUrl) });
    expect(mockPage.body).toContain("Pay now");
    expect(mockPage.body).toContain("$329.00");

    const approve = await app.inject({
      method: "POST",
      url: "/paypal/mock/approve",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: `token=${checkout.purchase.paypalOrderId}&action=approve`,
    });
    const returned = await app.inject({ method: "GET", url: pathOf(String(approve.headers.location)) });
    expect(returned.body).toContain('"kind":"purchase"');
    expect(returned.body).toContain("Payment complete");
    expect(returned.body).toContain(`/console?tab=${tabId}`);
    expect((await app.inject({ method: "GET", url: "/api/purchases" })).json<PurchaseDTO[]>()[0]?.status).toBe("captured");
    expect((await app.inject({ method: "POST", url: "/api/purchases/pur_missing/checkout" })).statusCode).toBe(404);
  });
});
