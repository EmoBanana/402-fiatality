/**
 * The sandbox client's Disputes v1, Invoicing v2 and refund calls against fake PayPal endpoints shaped like the
 * REST reference (customer-disputes/v1, invoicing/v2 and payments/v2 schema.json).
 */
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../context";
import { PaypalError } from "./errors";
import { createSandboxPaypal, disputeActionsOf, multipartInput, toDispute } from "./sandbox";

const API = "https://api-m.sandbox.paypal.com";

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Raw request body. */
  body: string;
}

type Reply = { status: number; body?: unknown };

function lower(headers: unknown): Record<string, string> {
  const raw = (headers as { toJSON?: () => unknown })?.toJSON?.() ?? headers ?? {};
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function setup(routes: Record<string, (seen: Seen) => Reply>) {
  const seen: Seen[] = [];
  const respond = (method: string, url: string, headers: Record<string, string>, body: string): Reply => {
    const u = new URL(url);
    const entry: Seen = { method: method.toUpperCase(), path: u.pathname, query: u.searchParams, headers, body };
    seen.push(entry);
    const route = routes[`${entry.method} ${entry.path}`];
    return route ? route(entry) : { status: 404, body: { name: "RESOURCE_NOT_FOUND", debug_id: "dbg404", message: "no route" } };
  };
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${API}/v1/oauth2/token`) {
      return new Response(JSON.stringify({ access_token: "token", token_type: "Bearer", expires_in: 32_400, scope: "" }), { status: 200 });
    }
    const reply = respond(init?.method ?? "GET", url, lower(init?.headers), typeof init?.body === "string" ? init.body : "");
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  // The Server SDK (refunds) goes through axios: answer it from the same routes.
  const adapter = async (config: { method?: string; url?: string; headers?: unknown; data?: unknown }) => {
    const reply = respond(config.method ?? "get", config.url ?? "", lower(config.headers), typeof config.data === "string" ? config.data : "");
    return { status: reply.status, statusText: String(reply.status), headers: { "content-type": "application/json" }, config, data: reply.body === undefined ? "" : JSON.stringify(reply.body) };
  };
  const config = { paypal: { mode: "sandbox", clientId: "id", clientSecret: "secret", invoiceRecords: true } } satisfies Pick<AppConfig, "paypal">;
  const paypal = createSandboxPaypal({ config, log: pino({ level: "silent" }) }, { fetch: fakeFetch, sdkConfig: { unstable_httpClientOptions: { adapter } } });
  return { paypal, seen };
}

const usd = (value: string) => ({ currency_code: "USD", value });
const link = (action: string, method = "POST") => ({ href: `${API}/v1/customer/disputes/PP-D-27803/${action}`, rel: action.replace(/-/g, "_"), method });

/** A dispute as GET /v1/customer/disputes/{id} returns it (fields from the dispute schema). */
const DETAILS = {
  dispute_id: "PP-D-27803",
  create_time: "2026-11-10T10:00:00.000Z",
  update_time: "2026-11-10T11:00:00.000Z",
  disputed_transactions: [{ buyer_transaction_id: "BUY-1", seller_transaction_id: "2GG279541U471931P", gross_amount: usd("12.34") }],
  reason: "UNAUTHORISED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_amount: usd("12.34"),
  dispute_life_cycle_stage: "INQUIRY",
  dispute_channel: "INTERNAL",
  messages: [
    { posted_by: "BUYER", time_posted: "2026-11-10T10:00:00.000Z", content: "I did not approve this." },
    { posted_by: "SELLER", time_posted: "2026-11-10T10:30:00.000Z", content: "Every call was signed." },
    { posted_by: "BUYER", time_posted: "2026-11-10T10:45:00.000Z", content: "Still not mine." },
  ],
  seller_response_due_date: "2026-11-20T10:00:00.000Z",
  links: [
    { href: `${API}/v1/customer/disputes/PP-D-27803`, rel: "self", method: "GET" },
    link("provide-evidence"),
    link("send-message"),
    link("accept-claim"),
    { href: `${API}/v1/customer/disputes/PP-D-27803/make-offer`, rel: "make_offer", method: "POST" },
  ],
};

describe("sandbox Disputes v1", () => {
  it("lists disputes updated since the cursor, page by page", async () => {
    const item = (n: number) => ({ dispute_id: `PP-D-${n}`, reason: "OTHER", status: "OPEN", dispute_amount: usd("1.00"), create_time: "2026-11-10T10:00:00Z", update_time: "2026-11-10T11:00:00Z" });
    const { paypal, seen } = setup({
      "GET /v1/customer/disputes": ({ query }) =>
        query.get("page") === "1"
          ? { status: 200, body: { items: Array.from({ length: 50 }, (_, i) => item(i)), links: [{ rel: "next", href: "x", method: "GET" }] } }
          : { status: 200, body: { items: [item(50)] } },
    });
    const list = await paypal.listDisputes({ updatedAfter: Date.parse("2026-11-09T00:00:00Z") });
    expect(list).toHaveLength(51);
    expect(list[0]).toEqual({ id: "PP-D-0", status: "OPEN", reason: "OTHER", stage: null, amountCents: 100, createdAt: Date.parse("2026-11-10T10:00:00Z"), updatedAt: Date.parse("2026-11-10T11:00:00Z") });
    expect(seen.map((s) => [s.query.get("page"), s.query.get("page_size"), s.query.get("update_time_after")])).toEqual([
      ["1", "50", "2026-11-09T00:00:00.000Z"],
      ["2", "50", "2026-11-09T00:00:00.000Z"],
    ]);
    // An account with no disputes answers without items.
    const empty = setup({ "GET /v1/customer/disputes": () => ({ status: 200, body: { links: [] } }) });
    expect(await empty.paypal.listDisputes()).toEqual([]);
    expect(empty.seen[0]!.query.has("update_time_after")).toBe(false);
  });

  it("maps dispute details: capture ids, the buyer's latest message, deadlines and allowed actions", async () => {
    const { paypal } = setup({ "GET /v1/customer/disputes/PP-D-27803": () => ({ status: 200, body: DETAILS }) });
    expect(await paypal.getDispute("PP-D-27803")).toEqual({
      id: "PP-D-27803",
      status: "WAITING_FOR_SELLER_RESPONSE",
      reason: "UNAUTHORISED",
      stage: "INQUIRY",
      amountCents: 1_234,
      createdAt: Date.parse("2026-11-10T10:00:00.000Z"),
      updatedAt: Date.parse("2026-11-10T11:00:00.000Z"),
      captureIds: ["2GG279541U471931P"],
      outcome: null,
      refundedCents: null,
      buyerMessage: "Still not mine.",
      sellerResponseDueAt: Date.parse("2026-11-20T10:00:00.000Z"),
      actions: ["provide_evidence", "send_message", "accept_claim", "make_offer"],
    });
  });

  it("reads what PayPal gave back to the buyer from the outcome, money movements or refunds", () => {
    const resolved = { ...DETAILS, status: "RESOLVED", links: [] };
    expect(toDispute({ ...resolved, dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", amount_refunded: usd("12.34") } })).toMatchObject({
      outcome: "RESOLVED_BUYER_FAVOUR",
      refundedCents: 1_234,
    });
    expect(
      toDispute({
        ...resolved,
        dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" },
        money_movements: [
          { affected_party: "SELLER", type: "DEBIT", reason: "DISPUTE_SETTLEMENT", amount: usd("5.00") },
          { affected_party: "SELLER", type: "DEBIT", reason: "DISPUTE_FEE", amount: usd("15.00") },
          { affected_party: "BUYER", type: "CREDIT", reason: "DISPUTE_SETTLEMENT", amount: usd("5.00") },
        ],
      }),
    ).toMatchObject({ refundedCents: 500 });
    expect(toDispute({ ...resolved, refund_details: { transactions: [{ id: "R1", gross_amount: usd("2.00") }, { id: "R2", gross_amount: usd("1.00") }] } })).toMatchObject({
      refundedCents: 300,
    });
    expect(toDispute({ ...resolved, dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } })).toMatchObject({ refundedCents: null });
    expect(toDispute({ reason: "OTHER" })).toBeNull();
    expect(disputeActionsOf([{ href: "https://x/v1/customer/disputes/1/require-evidence", rel: "require_evidence", method: "POST" }, { rel: "self", method: "GET" }])).toEqual([
      "require_evidence",
    ]);
  });

  it("sends evidence as multipart/form-data with an `input` JSON part", async () => {
    const { paypal, seen } = setup({ "POST /v1/customer/disputes/PP-D-27803/provide-evidence": () => ({ status: 200, body: { links: [] } }) });
    await paypal.provideDisputeEvidence("PP-D-27803", { notes: "Every call was signed.", evidenceType: "OTHER" });
    const request = seen[0]!;
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(request.headers["content-type"]!)?.[1];
    expect(boundary).toBeTruthy();
    expect(request.body).toBe(
      `--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n` +
        `{"evidences":[{"evidence_type":"OTHER","notes":"Every call was signed."}]}\r\n--${boundary}--\r\n`,
    );
    // A real multipart parser reads the same part back.
    const parsed = await new Response(request.body, { headers: { "content-type": request.headers["content-type"]! } }).formData();
    expect(JSON.parse(String(parsed.get("input")))).toEqual({ evidences: [{ evidence_type: "OTHER", notes: "Every call was signed." }] });
    expect(multipartInput({ a: 1 }).contentType).toMatch(/^multipart\/form-data; boundary=----p402-[0-9a-f]{24}$/);
  });

  it("makes offers, escalates and settles with JSON bodies", async () => {
    const ok = () => ({ status: 200, body: { links: [] } });
    const { paypal, seen } = setup({
      "POST /v1/customer/disputes/PP-D-27803/make-offer": ok,
      "POST /v1/customer/disputes/PP-D-27803/escalate": ok,
      "POST /v1/customer/disputes/PP-D-27803/adjudicate": ok,
      "POST /v1/customer/disputes/PP-D-27803/require-evidence": ok,
    });
    await paypal.makeDisputeOffer("PP-D-27803", { amountCents: 21, note: "Goodwill refund", invoiceId: "offer-PP-D-27803" });
    await paypal.escalateDispute("PP-D-27803", "Escalate for the demo");
    await paypal.adjudicateDispute("PP-D-27803", "BUYER_FAVOR");
    await paypal.requireDisputeEvidence("PP-D-27803", "SELLER_EVIDENCE");
    expect(seen.map((s) => [s.path.split("/").pop(), s.headers["content-type"], JSON.parse(s.body)])).toEqual([
      ["make-offer", "application/json", { note: "Goodwill refund", offer_amount: usd("0.21"), offer_type: "REFUND", invoice_id: "offer-PP-D-27803" }],
      ["escalate", "application/json", { note: "Escalate for the demo" }],
      ["adjudicate", "application/json", { adjudication_outcome: "BUYER_FAVOR" }],
      ["require-evidence", "application/json", { action: "SELLER_EVIDENCE" }],
    ]);
  });

  it("accepts a claim as JSON and retries as multipart only when PayPal rejects the encoding", async () => {
    let calls = 0;
    const { paypal, seen } = setup({
      "POST /v1/customer/disputes/PP-D-27803/accept-claim": () =>
        ++calls === 1 ? { status: 415, body: { name: "UNSUPPORTED_MEDIA_TYPE", debug_id: "dbg415" } } : { status: 200, body: { links: [] } },
    });
    await paypal.acceptDisputeClaim("PP-D-27803", { note: "Partial refund", refundCents: 300 });
    expect(seen.map((s) => s.headers["content-type"]!.split(";")[0])).toEqual(["application/json", "multipart/form-data"]);
    expect(JSON.parse(seen[0]!.body)).toEqual({ note: "Partial refund", accept_claim_type: "PARTIAL_REFUND", refund_amount: usd("3.00") });
    expect(seen[1]!.body).toContain('{"note":"Partial refund","accept_claim_type":"PARTIAL_REFUND","refund_amount":{"currency_code":"USD","value":"3.00"}}');

    const strict = setup({
      "POST /v1/customer/disputes/PP-D-27803/accept-claim": () => ({
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg422", details: [{ issue: "ACCEPT_CLAIM_NOT_ALLOWED", description: "Not allowed." }] },
      }),
    });
    const err = await strict.paypal.acceptDisputeClaim("PP-D-27803", { note: "Full refund" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaypalError);
    expect(err).toMatchObject({ httpStatus: 422, debugId: "dbg422" });
    expect(strict.seen).toHaveLength(1);
    expect(JSON.parse(strict.seen[0]!.body)).toEqual({ note: "Full refund", accept_claim_type: "REFUND" });
  });
});

describe("sandbox Invoicing v2", () => {
  const input = {
    invoiceNumber: "FIAT-stl_abc",
    reference: "tab_1",
    recipientEmail: "buyer@personal.example.com",
    itemName: "Agent API usage",
    itemDescription: "Channel3: 200 calls, $1.00. Paid by PayPal capture 2GG279541U471931P.",
    amountCents: 1_234,
    note: "Already paid with PayPal.",
    memo: "capture 2GG279541U471931P",
    paymentNote: "Paid by PayPal capture 2GG279541U471931P",
    requestId: "invoice-stl_abc",
  };
  const invoice = (status: string, extra: Record<string, unknown> = {}) => ({
    id: "INV2-Z56S-5LLA-Q52L-CPZ5",
    status,
    detail: { invoice_number: "FIAT-stl_abc", currency_code: "USD", metadata: { recipient_view_url: "https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5" } },
    amount: usd("12.34"),
    ...extra,
  });

  it("drafts, sends as a share link and records the payment", async () => {
    let status = "DRAFT";
    const { paypal, seen } = setup({
      "POST /v2/invoicing/invoices": () => ({ status: 201, body: invoice("DRAFT") }),
      "GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5": () => ({ status: 200, body: invoice(status) }),
      "POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/send": () => {
        status = "UNPAID";
        return { status: 200, body: { href: "https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5", rel: "payer-view", method: "GET" } };
      },
      "POST /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/payments": () => {
        status = "MARKED_AS_PAID";
        return { status: 200, body: { payment_id: "EXTR-86F38350LX4353815" } };
      },
    });
    expect(await paypal.createInvoiceRecord(input)).toEqual({
      id: "INV2-Z56S-5LLA-Q52L-CPZ5",
      invoiceNumber: "FIAT-stl_abc",
      status: "MARKED_AS_PAID",
      amountCents: 1_234,
      url: "https://www.sandbox.paypal.com/invoice/p/#Z56S5LLAQ52LCPZ5",
    });
    const posts = seen.filter((s) => s.method === "POST");
    expect(posts.map((s) => s.path)).toEqual([
      "/v2/invoicing/invoices",
      "/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/send",
      "/v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5/payments",
    ]);
    expect(posts[0]!.headers).toMatchObject({ "paypal-request-id": "invoice-stl_abc", prefer: "return=representation" });
    expect(JSON.parse(posts[0]!.body)).toEqual({
      detail: {
        invoice_number: "FIAT-stl_abc",
        reference: "tab_1",
        currency_code: "USD",
        note: "Already paid with PayPal.",
        memo: "capture 2GG279541U471931P",
        payment_term: { term_type: "DUE_ON_RECEIPT" },
      },
      invoicer: { business_name: "402 Fiatality" },
      items: [{ name: "Agent API usage", description: input.itemDescription, quantity: "1", unit_amount: usd("12.34"), unit_of_measure: "AMOUNT" }],
      primary_recipients: [{ billing_info: { email_address: "buyer@personal.example.com" } }],
    });
    expect(JSON.parse(posts[1]!.body)).toEqual({ send_to_invoicer: false, send_to_recipient: false });
    expect(JSON.parse(posts[2]!.body)).toEqual({ method: "PAYPAL", amount: usd("12.34"), note: input.paymentNote });
  });

  it("resumes an invoice an earlier attempt created, found by its number", async () => {
    const { paypal, seen } = setup({
      "POST /v2/invoicing/invoices": () => ({
        status: 422,
        body: { name: "UNPROCESSABLE_ENTITY", debug_id: "dbg-dup", details: [{ issue: "DUPLICATE_INVOICE_NUMBER", description: "Invoice number already in use." }] },
      }),
      "POST /v2/invoicing/search-invoices": () => ({ status: 200, body: { total_items: 1, items: [invoice("MARKED_AS_PAID")] } }),
      "GET /v2/invoicing/invoices/INV2-Z56S-5LLA-Q52L-CPZ5": () => ({ status: 200, body: invoice("MARKED_AS_PAID") }),
    });
    expect(await paypal.createInvoiceRecord(input)).toMatchObject({ id: "INV2-Z56S-5LLA-Q52L-CPZ5", status: "MARKED_AS_PAID" });
    expect(JSON.parse(seen.find((s) => s.path.endsWith("search-invoices"))!.body)).toEqual({ invoice_number: "FIAT-stl_abc" });
    expect(seen.some((s) => s.path.endsWith("/payments"))).toBe(false);
  });
});

describe("sandbox refunds (Payments v2)", () => {
  it("refunds part of a capture with PayPal-Request-Id", async () => {
    const { paypal, seen } = setup({
      "POST /v2/payments/captures/2GG279541U471931P/refund": () => ({ status: 201, body: { id: "1JU08902781691411", status: "COMPLETED", amount: usd("2.10") } }),
    });
    expect(await paypal.refundCapture("2GG279541U471931P", { amountCents: 210, invoiceId: "refund-PP-D-1", noteToPayer: "Goodwill refund", requestId: "refund-PP-D-1" })).toEqual({
      id: "1JU08902781691411",
      status: "COMPLETED",
      amountCents: 210,
    });
    expect(seen[0]!.headers).toMatchObject({ "paypal-request-id": "refund-PP-D-1", prefer: "return=representation" });
    expect(JSON.parse(seen[0]!.body)).toEqual({ amount: usd("2.10"), invoice_id: "refund-PP-D-1", note_to_payer: "Goodwill refund" });
  });
});
