/**
 * The sandbox client end to end through the real @paypal/paypal-server-sdk, offline: an axios adapter
 * stands in for PayPal's Orders/Payments endpoints and a fake fetch for OAuth and Payouts.
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../context";
import { outcomeUnknown, PaypalError } from "./errors";
import { createSandboxPaypal } from "./sandbox";

const API = "https://api-m.sandbox.paypal.com";
const SECRET = "client-secret-DO-NOT-LOG";
const ACCESS_TOKEN = "A21AA-access-token-DO-NOT-LOG";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function lowerHeaders(headers: unknown): Record<string, string> {
  const raw = (headers as { toJSON?: () => unknown })?.toJSON?.() ?? headers ?? {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function setup(routes: Record<string, (seen: Seen) => Reply>) {
  const seen: Seen[] = [];
  let tokenFetches = 0;
  const respond = (method: string, url: string, headers: Record<string, string>, body: unknown): Reply => {
    const entry = { method: method.toUpperCase(), url, headers, body };
    seen.push(entry);
    const path = url.replace(API, "").replace(/\?.*$/, "");
    const route = routes[`${entry.method} ${path}`];
    return route ? route(entry) : { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "dbg404", message: "no route" } };
  };
  const adapter = async (config: { method?: string; url?: string; headers?: unknown; data?: unknown }) => {
    const body = typeof config.data === "string" && config.data ? JSON.parse(config.data) : undefined;
    const reply = respond(config.method ?? "get", config.url ?? "", lowerHeaders(config.headers), body);
    return {
      status: reply.status,
      statusText: String(reply.status),
      headers: { "content-type": "application/json", "paypal-debug-id": "hdr-debug", ...reply.headers },
      config,
      data: reply.body === undefined ? "" : JSON.stringify(reply.body),
    };
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = lowerHeaders(init?.headers);
    if (url === `${API}/v1/oauth2/token`) {
      tokenFetches++;
      seen.push({ method: "POST", url, headers, body: init?.body });
      const reply = routes["POST /v1/oauth2/token"]?.({ method: "POST", url, headers, body: init?.body }) ?? {
        status: 200,
        body: { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 32_400, scope: "https://uri.paypal.com/services/payments/payouts" },
      };
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const reply = respond(init?.method ?? "GET", url, headers, body);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json", "paypal-debug-id": "hdr-debug", ...reply.headers },
    });
  }) as typeof fetch;

  const logs: string[] = [];
  const config = { paypal: { mode: "sandbox", clientId: "client-id", clientSecret: SECRET, invoiceRecords: false } } satisfies Pick<AppConfig, "paypal">;
  const paypal = createSandboxPaypal(
    { config, log: pino({ level: "debug" }, { write: (line: string) => logs.push(line) }) },
    { fetch: fakeFetch, sdkConfig: { unstable_httpClientOptions: { adapter } } },
  );
  return { paypal, seen, logs, tokenFetches: () => tokenFetches };
}

const orderLinks = (id: string) => [
  { href: `${API}/v2/checkout/orders/${id}`, rel: "self", method: "GET" },
  { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: "payer-action", method: "GET" },
];

const holdInput = {
  referenceId: "tab_abc",
  amountCents: 5_000,
  description: "Agent spending tab",
  softDescriptor: "FIATALITY AGENT TAB",
  brandName: "402 Fiatality",
  returnUrl: "http://localhost:4020/paypal/return?kind=tab&ref=tab_abc",
  cancelUrl: "http://localhost:4020/paypal/cancel?kind=tab&ref=tab_abc",
  requestId: "hold-tab_abc",
};

describe("sandbox PayPal client (Server SDK)", () => {
  it("creates the AUTHORIZE hold order exactly as SPEC §6.2 describes", async () => {
    const { paypal, seen } = setup({
      "POST /v2/checkout/orders": () => ({ status: 200, body: { id: "5O190127TN364715T", status: "PAYER_ACTION_REQUIRED", links: orderLinks("5O190127TN364715T") } }),
    });
    const order = await paypal.createAuthorizeOrder(holdInput);
    expect(order).toEqual({
      id: "5O190127TN364715T",
      status: "PAYER_ACTION_REQUIRED",
      approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=5O190127TN364715T",
    });
    const request = seen.find((s) => s.url.endsWith("/v2/checkout/orders"))!;
    expect(request.headers).toMatchObject({
      "paypal-request-id": "hold-tab_abc",
      prefer: "return=representation",
      authorization: `Bearer ${ACCESS_TOKEN}`,
    });
    expect(request.body).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: "tab_abc",
          custom_id: "tab_abc",
          description: "Agent spending tab",
          soft_descriptor: "FIATALITY AGENT TAB",
          amount: { currency_code: "USD", value: "50.00" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "402 Fiatality",
            return_url: holdInput.returnUrl,
            cancel_url: holdInput.cancelUrl,
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    });
  });

  it("creates the CAPTURE purchase order with one item", async () => {
    const { paypal, seen } = setup({
      "POST /v2/checkout/orders": () => ({ status: 200, body: { id: "8AB", status: "PAYER_ACTION_REQUIRED", links: orderLinks("8AB") } }),
    });
    await paypal.createCaptureOrder({
      referenceId: "pur_1",
      amountCents: 14_900,
      itemName: "Espresso machine",
      description: "Agent purchase after $0.37 of agent research",
      brandName: "402 Fiatality",
      returnUrl: "http://localhost:4020/paypal/return?kind=purchase&ref=pur_1",
      cancelUrl: "http://localhost:4020/paypal/cancel?kind=purchase&ref=pur_1",
      requestId: "checkout-pur_1",
    });
    const body = seen.find((s) => s.url.endsWith("/v2/checkout/orders"))!.body as Record<string, any>;
    expect(body.intent).toBe("CAPTURE");
    expect(body.purchase_units[0]).toMatchObject({
      amount: { currency_code: "USD", value: "149.00", breakdown: { item_total: { currency_code: "USD", value: "149.00" } } },
      items: [{ name: "Espresso machine", quantity: "1", unit_amount: { currency_code: "USD", value: "149.00" } }],
    });
    expect(body.payment_source.paypal.experience_context.user_action).toBe("PAY_NOW");
  });

  it("authorizes, reauthorizes, captures with final_capture and voids", async () => {
    const { paypal, seen } = setup({
      "POST /v2/checkout/orders/5O1/authorize": () => ({
        status: 201,
        body: {
          id: "5O1",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: "tab_abc",
              payments: {
                authorizations: [
                  { id: "0VF52814937998046", status: "CREATED", amount: { currency_code: "USD", value: "50.00" }, expiration_time: "2026-12-07T12:00:00Z" },
                ],
              },
            },
          ],
        },
      }),
      "POST /v2/payments/authorizations/0VF52814937998046/reauthorize": () => ({
        status: 201,
        body: { id: "8AA831015G517922L", status: "CREATED", amount: { currency_code: "USD", value: "50.00" }, expiration_time: "2026-12-07T12:00:00Z" },
      }),
      "POST /v2/payments/authorizations/8AA831015G517922L/capture": () => ({
        status: 201,
        body: {
          id: "2GG279541U471931P",
          status: "COMPLETED",
          amount: { currency_code: "USD", value: "12.34" },
          final_capture: true,
          seller_receivable_breakdown: {
            gross_amount: { currency_code: "USD", value: "12.34" },
            paypal_fee: { currency_code: "USD", value: "0.92" },
            net_amount: { currency_code: "USD", value: "11.42" },
          },
        },
      }),
      // PayPal answers a void with 204 No Content.
      "POST /v2/payments/authorizations/8AA831015G517922L/void": () => ({ status: 204, body: undefined }),
    });

    const auth = await paypal.authorizeOrder("5O1", "authorize-tab_abc");
    expect(auth).toEqual({ id: "0VF52814937998046", status: "CREATED", amountCents: 5_000, expiresAt: Date.parse("2026-12-07T12:00:00Z") });

    const reauth = await paypal.reauthorize(auth.id, 5_000, "reauth-tab_abc");
    expect(reauth.id).toBe("8AA831015G517922L");

    const capture = await paypal.captureAuthorization(reauth.id, {
      amountCents: 1_234,
      finalCapture: true,
      invoiceId: "stl_1",
      noteToPayer: "Agent API usage, 3 calls across 2 sellers",
      requestId: "capture-stl_1",
    });
    expect(capture).toEqual({ id: "2GG279541U471931P", status: "COMPLETED", amountCents: 1_234, feeCents: 92, finalCapture: true });
    await paypal.voidAuthorization(reauth.id, "void-rest-stl_1");

    const byPath = (suffix: string) => seen.find((s) => s.url.endsWith(suffix))!;
    expect(byPath("/authorize").headers["paypal-request-id"]).toBe("authorize-tab_abc");
    expect(byPath("/reauthorize").body).toEqual({ amount: { currency_code: "USD", value: "50.00" } });
    expect(byPath("/reauthorize").headers["paypal-request-id"]).toBe("reauth-tab_abc");
    expect(byPath("/capture").headers).toMatchObject({ "paypal-request-id": "capture-stl_1", prefer: "return=representation" });
    expect(byPath("/capture").body).toEqual({
      amount: { currency_code: "USD", value: "12.34" },
      final_capture: true,
      invoice_id: "stl_1",
      note_to_payer: "Agent API usage, 3 calls across 2 sellers",
    });
    expect(byPath("/void").headers["paypal-request-id"]).toBe("void-rest-stl_1");
  });

  it("maps PayPal errors to PaypalError with debug_id and never logs secrets", async () => {
    const { paypal, logs } = setup({
      "POST /v2/payments/authorizations/AUTH1/capture": () => ({
        status: 422,
        body: {
          name: "UNPROCESSABLE_ENTITY",
          message: "The requested action could not be performed, semantically incorrect, or failed business validation.",
          debug_id: "f2a1b3c4d5e6",
          details: [{ issue: "AUTHORIZATION_EXPIRED", description: "Authorization has expired." }],
        },
      }),
    });
    const err = await paypal
      .captureAuthorization("AUTH1", { amountCents: 100, finalCapture: true, invoiceId: "stl_9", noteToPayer: "", requestId: "capture-stl_9" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect(err).toMatchObject({
      status: 502,
      code: "paypal_error",
      httpStatus: 422,
      debugId: "f2a1b3c4d5e6",
      details: { name: "UNPROCESSABLE_ENTITY", debug_id: "f2a1b3c4d5e6", issues: [{ issue: "AUTHORIZATION_EXPIRED", description: "Authorization has expired." }] },
    });
    expect((err as PaypalError).message).toContain("AUTHORIZATION_EXPIRED");
    const logged = logs.join("\n");
    expect(logged).toContain("f2a1b3c4d5e6");
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(err)).not.toContain(ACCESS_TOKEN);
  });

  it("falls back to the paypal-debug-id header and reports network failures", async () => {
    const { paypal } = setup({ "GET /v2/checkout/orders/X1": () => ({ status: 500, body: "oops", headers: { "paypal-debug-id": "hdr-500" } }) });
    await expect(paypal.getOrder("X1")).rejects.toMatchObject({ debugId: "hdr-500", httpStatus: 500 });

    const offline = createSandboxPaypal(
      { config: { paypal: { mode: "sandbox", clientId: "id", clientSecret: SECRET, invoiceRecords: false } }, log: pino({ level: "silent" }) },
      { fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch },
    );
    await expect(offline.getPayoutBatch("B1")).rejects.toMatchObject({ paypalName: "NETWORK_ERROR", status: 502 });
  });
});

describe("sandbox PayPal client: purchase refunds (paypal-plan.md)", () => {
  const input = { amountCents: 1_250, invoiceId: "refund-rfd_1", requestId: "refund-rfd_1" };

  it("sends a refund with only the fields the plan requires", async () => {
    const { paypal, seen } = setup({
      "POST /v2/payments/captures/CAP1/refund": () => ({
        status: 201,
        body: { id: "REF1", status: "COMPLETED", amount: { currency_code: "USD", value: "12.50" }, invoice_id: "refund-rfd_1" },
      }),
    });
    expect(await paypal.refundCapture("CAP1", input)).toEqual({ id: "REF1", status: "COMPLETED", amountCents: 1_250 });

    const sent = seen.find((s) => s.url === `${API}/v2/payments/captures/CAP1/refund`);
    expect(sent?.method).toBe("POST");
    expect(sent?.headers["paypal-request-id"]).toBe("refund-rfd_1");
    expect(sent?.headers.prefer).toBe("return=representation");
    expect(sent?.headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    // No note_to_payer, custom_id or payment_instruction: nothing requires them.
    expect(sent?.body).toEqual({ amount: { currency_code: "USD", value: "12.50" }, invoice_id: "refund-rfd_1" });
  });

  it("takes the amount it sent when PayPal names none", async () => {
    const { paypal } = setup({ "POST /v2/payments/captures/CAP1/refund": () => ({ status: 201, body: { id: "REF2", status: "PENDING" } }) });
    expect(await paypal.refundCapture("CAP1", input)).toEqual({ id: "REF2", status: "PENDING", amountCents: 1_250 });
    expect(await paypal.refundCapture("CAP1", { ...input, amountCents: null })).toEqual({ id: "REF2", status: "PENDING", amountCents: null });
  });

  it("calls a lost answer unknown, and a token failure a refund that was never sent", async () => {
    const lost = setup({
      "POST /v2/payments/captures/CAP1/refund": () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    const lostErr = await lost.paypal.refundCapture("CAP1", input).catch((e: unknown) => e);
    expect(lostErr).toMatchObject({ operation: "refund capture", paypalName: "NETWORK_ERROR", httpStatus: null });
    expect(outcomeUnknown(lostErr, "refund capture")).toBe(true);

    const noToken = setup({
      "POST /v1/oauth2/token": () => ({ status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } }),
    });
    const tokenErr = await noToken.paypal.refundCapture("CAP1", input).catch((e: unknown) => e);
    expect(tokenErr).toMatchObject({ operation: "OAuth token request", httpStatus: 401 });
    expect(outcomeUnknown(tokenErr, "refund capture")).toBe(false);
    expect(noToken.seen.some((s) => s.url.endsWith("/refund"))).toBe(false);
  });

  it("reads the order's capture and refunds, so a lost answer can be found again", async () => {
    const { paypal } = setup({
      "GET /v2/checkout/orders/O1": () => ({
        status: 200,
        body: {
          id: "O1",
          status: "COMPLETED",
          purchase_units: [
            {
              reference_id: "pur_1",
              payments: {
                captures: [{ id: "CAP1", status: "PARTIALLY_REFUNDED", amount: { currency_code: "USD", value: "329.00" } }],
                refunds: [{ id: "REF1", status: "COMPLETED", amount: { currency_code: "USD", value: "12.50" }, invoice_id: "refund-rfd_1" }],
              },
            },
          ],
        },
      }),
    });
    expect(await paypal.getOrder("O1")).toMatchObject({
      id: "O1",
      status: "COMPLETED",
      captureId: "CAP1",
      refunds: [{ id: "REF1", status: "COMPLETED", amountCents: 1_250, invoiceId: "refund-rfd_1" }],
    });
  });
});

describe("sandbox PayPal client (Payouts REST + OAuth)", () => {
  it("sends one batch with PayPal-Request-Id, reuses the token and maps item results", async () => {
    const { paypal, seen, tokenFetches } = setup({
      "POST /v1/payments/payouts": () => ({ status: 201, body: { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } } }),
      "GET /v1/payments/payouts/BATCH1": () => ({
        status: 200,
        body: {
          batch_header: { payout_batch_id: "BATCH1", batch_status: "SUCCESS" },
          items: [
            {
              payout_item_id: "ITEM1",
              transaction_status: "SUCCESS",
              payout_item_fee: { currency: "USD", value: "0.25" },
              payout_item: { sender_item_id: "po_1:channel3", amount: { currency: "USD", value: "9.75" }, receiver: "c3@example.com" },
            },
          ],
        },
      }),
    });
    const created = await paypal.createPayoutBatch({
      senderBatchId: "po_1",
      emailSubject: "You have a payout from 402 Fiatality",
      note: "402 Fiatality weekly payout",
      items: [{ senderItemId: "po_1:channel3", receiverEmail: "c3@example.com", amountCents: 975, note: "402 Fiatality weekly payout" }],
    });
    expect(created).toEqual({
      batchId: "BATCH1",
      status: "PENDING",
      items: [{ senderItemId: "po_1:channel3", payoutItemId: null, status: "PENDING", amountCents: 975, feeCents: null }],
    });
    const batch = await paypal.getPayoutBatch("BATCH1");
    expect(batch.items).toEqual([{ senderItemId: "po_1:channel3", payoutItemId: "ITEM1", status: "SUCCESS", amountCents: 975, feeCents: 25 }]);

    const post = seen.find((s) => s.method === "POST" && s.url.endsWith("/v1/payments/payouts"))!;
    expect(post.headers).toMatchObject({ "paypal-request-id": "po_1", authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/json" });
    expect(post.body).toEqual({
      sender_batch_header: {
        sender_batch_id: "po_1",
        recipient_type: "EMAIL",
        email_subject: "You have a payout from 402 Fiatality",
        email_message: "402 Fiatality weekly payout",
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: { value: "9.75", currency: "USD" },
          note: "402 Fiatality weekly payout",
          sender_item_id: "po_1:channel3",
          receiver: "c3@example.com",
        },
      ],
    });
    const tokenRequest = seen.find((s) => s.url.endsWith("/v1/oauth2/token"))!;
    expect(tokenRequest.headers.authorization).toBe(`Basic ${Buffer.from(`client-id:${SECRET}`).toString("base64")}`);
    expect(tokenRequest.body).toBe("grant_type=client_credentials");
    expect(tokenFetches()).toBe(1);
  });

  it("drops the token after a 401 and fetches a fresh one", async () => {
    let first = true;
    const { paypal, tokenFetches } = setup({
      "GET /v1/payments/payouts/B2": () => {
        if (first) {
          first = false;
          return { status: 401, body: { error: "invalid_token", error_description: "Token signature verification failed" } };
        }
        return { status: 200, body: { batch_header: { payout_batch_id: "B2", batch_status: "SUCCESS" }, items: [] } };
      },
    });
    await expect(paypal.getPayoutBatch("B2")).rejects.toMatchObject({ paypalName: "invalid_token", httpStatus: 401 });
    await expect(paypal.getPayoutBatch("B2")).resolves.toMatchObject({ status: "SUCCESS" });
    expect(tokenFetches()).toBe(2);
  });

  it("reports bad credentials without echoing them", async () => {
    const { paypal } = setup({
      "POST /v1/oauth2/token": () => ({ status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } }),
    });
    const err = (await paypal.getPayoutBatch("B3").catch((e: unknown) => e)) as PaypalError;
    expect(err).toBeInstanceOf(PaypalError);
    expect(err.paypalName).toBe("invalid_client");
    expect(err.message).toContain("Client Authentication failed");
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(SECRET);
  });
});
