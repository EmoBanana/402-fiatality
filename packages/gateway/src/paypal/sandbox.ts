/**
 * PaypalClient against the PayPal sandbox (SPEC §6.1).
 *
 * Orders v2 and Payments v2 (including refunds) go through `@paypal/paypal-server-sdk` (OrdersController,
 * PaymentsController). Payouts v1, Disputes v1 and Invoicing v2 are not in the SDK, so they are plain REST
 * with the same cached OAuth token. Every money-moving call sends `PayPal-Request-Id` (callers derive it
 * from our ids, so retries are idempotent) and asks for `Prefer: return=representation` so captures include
 * `seller_receivable_breakdown.paypal_fee`.
 *
 * Disputes v1 shapes (developer.paypal.com/docs/api/customer-disputes/v1, schema.json): provide-evidence takes
 * multipart/form-data with an `input` part holding `{"evidences":[...]}` as application/json (built by hand so
 * the part has no filename, exactly like `curl -F 'input=...;type=application/json'`); make-offer, escalate,
 * adjudicate and require-evidence take JSON; send-message and accept-claim are sent one way and retried the
 * other way once if PayPal rejects the encoding. Responses are parsed tolerantly.
 */
import {
  CheckoutPaymentIntent,
  Client,
  type Configuration,
  Environment,
  OrdersController,
  PaymentsController,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type AuthorizationWithAdditionalData,
  type CapturedPayment,
  type LinkDescription,
  type Order,
  type OrdersCapture,
  type PaymentAuthorization,
} from "@paypal/paypal-server-sdk";
import { randomBytes } from "node:crypto";
import { centsToValue, valueToCents } from "@p402/shared";
import { z } from "zod";
import {
  AppError,
  type AppConfig,
  type Logger,
  type PaypalAuthorization,
  type PaypalCapture,
  type PaypalClient,
  type PaypalDispute,
  type PaypalDisputeSummary,
  type PaypalInvoice,
  type PaypalInvoiceInput,
  type PaypalOrder,
  type PaypalPayoutBatch,
} from "../context";
import { PaypalError, paypalErrorFromResponse, toPaypalError } from "./errors";
import { createTokenSource, PAYPAL_SANDBOX_API, type TokenSource } from "./oauth";

export type SdkOrders = Pick<OrdersController, "createOrder" | "getOrder" | "authorizeOrder" | "captureOrder">;
export type SdkPayments = Pick<
  PaymentsController,
  "getAuthorizedPayment" | "captureAuthorizedPayment" | "reauthorizePayment" | "voidPayment" | "refundCapturedPayment"
>;

export interface SandboxPaypalOptions {
  /** REST origin, default https://api-m.sandbox.paypal.com. */
  baseUrl?: string;
  /** For Payouts and the OAuth token (tests inject a fake). */
  fetch?: typeof fetch;
  tokens?: TokenSource;
  /** SDK controllers (tests inject fakes). */
  orders?: SdkOrders;
  payments?: SdkPayments;
  /** Extra Server SDK configuration (tests pass an axios `adapter` via unstable_httpClientOptions). */
  sdkConfig?: Partial<Configuration>;
  timeoutMs?: number;
}

const CURRENCY = "USD";
const REPRESENTATION = "return=representation";
/** The SDK re-asks our token source at least this often, so a token dropped after a 401 is replaced soon. */
const SDK_TOKEN_MAX_AGE_MS = 5 * 60_000;

const usd = (cents: number) => ({ currencyCode: CURRENCY, value: centsToValue(cents) });

export function createSandboxPaypal(
  deps: { config: Pick<AppConfig, "paypal">; log: Logger },
  opts: SandboxPaypalOptions = {},
): PaypalClient {
  const { clientId, clientSecret } = deps.config.paypal;
  if (!clientId || !clientSecret) {
    throw new AppError(503, "paypal_not_configured", "PAYPAL_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.");
  }
  const baseUrl = opts.baseUrl ?? PAYPAL_SANDBOX_API;
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const tokens = opts.tokens ?? createTokenSource({ baseUrl, clientId, clientSecret, fetch: doFetch, timeoutMs });

  let orders = opts.orders;
  let payments = opts.payments;
  if (!orders || !payments) {
    const sdk = new Client({
      environment: Environment.Sandbox,
      timeout: timeoutMs,
      clientCredentialsAuthCredentials: {
        // Our token source holds the credentials; the SDK only ever sees short-lived access tokens.
        oAuthClientId: "",
        oAuthClientSecret: "",
        oAuthTokenProvider: async () => {
          const token = await tokens.get();
          const expiry = Math.min(token.expiresAt, Date.now() + SDK_TOKEN_MAX_AGE_MS);
          return { accessToken: token.value, tokenType: "Bearer", expiry: BigInt(Math.floor(expiry / 1000)) };
        },
      },
      ...opts.sdkConfig,
    });
    orders ??= new OrdersController(sdk);
    payments ??= new PaymentsController(sdk);
  }
  const ordersApi = orders;
  const paymentsApi = payments;

  async function call<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const error = toPaypalError(err, operation);
      if (error.httpStatus === 401) tokens.invalidate();
      deps.log.warn(error.toLog(), "PayPal call failed");
      throw error;
    }
  }

  async function rest(
    operation: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    requestId?: string,
    opts: { multipart?: boolean; prefer?: string; query?: Record<string, string | number | undefined | null> } = {},
  ): Promise<unknown> {
    const token = await tokens.get();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.value}`,
      accept: "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined && opts.multipart) {
      const form = multipartInput(body);
      headers["content-type"] = form.contentType;
      payload = form.body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    if (requestId) headers["paypal-request-id"] = requestId;
    if (opts.prefer) headers.prefer = opts.prefer;
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(opts.query ?? {})) if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}${query.size > 0 ? `?${query}` : ""}`, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toPaypalError(err, operation);
    }
    // 204 No Content, and the empty 200s some actions answer with, parse as null.
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    if (!res.ok) throw paypalErrorFromResponse(operation, res.status, json, res.headers);
    return json;
  }

  /** POST a dispute action. `encodings` are tried in order; the next one only when PayPal rejects the encoding itself. */
  async function disputeAction(operation: string, disputeId: string, action: string, body: unknown, encodings: Array<"json" | "multipart">): Promise<void> {
    const path = `/v1/customer/disputes/${encodeURIComponent(disputeId)}/${action}`;
    for (let i = 0; i < encodings.length; i++) {
      try {
        await rest(operation, "POST", path, body, undefined, { multipart: encodings[i] === "multipart" });
        return;
      } catch (err) {
        if (i < encodings.length - 1 && err instanceof PaypalError && rejectedEncoding(err)) continue;
        throw err;
      }
    }
  }

  async function getInvoice(operation: string, invoiceId: string): Promise<PaypalInvoice> {
    const json = await rest(operation, "GET", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}`);
    const invoice = toInvoice(json);
    if (!invoice) throw invalidResponse(operation, "unexpected invoice response");
    return invoice;
  }

  return {
    mode: "sandbox",

    createAuthorizeOrder(input) {
      const operation = "create hold order";
      return call(operation, async () => {
        const { result } = await ordersApi.createOrder({
          body: {
            intent: CheckoutPaymentIntent.Authorize,
            purchaseUnits: [
              {
                referenceId: input.referenceId,
                customId: input.referenceId,
                description: input.description.slice(0, 127),
                softDescriptor: input.softDescriptor.slice(0, 22),
                amount: usd(input.amountCents),
              },
            ],
            paymentSource: {
              paypal: {
                experienceContext: {
                  brandName: input.brandName.slice(0, 127),
                  returnUrl: input.returnUrl,
                  cancelUrl: input.cancelUrl,
                  userAction: PaypalExperienceUserAction.Continue,
                  shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                },
              },
            },
          },
          paypalRequestId: input.requestId,
          prefer: REPRESENTATION,
        });
        return toOrder(result, operation);
      });
    },

    createCaptureOrder(input) {
      const operation = "create purchase order";
      return call(operation, async () => {
        const { result } = await ordersApi.createOrder({
          body: {
            intent: CheckoutPaymentIntent.Capture,
            purchaseUnits: [
              {
                referenceId: input.referenceId,
                customId: input.referenceId,
                description: input.description.slice(0, 127),
                amount: { ...usd(input.amountCents), breakdown: { itemTotal: usd(input.amountCents) } },
                items: [{ name: input.itemName.slice(0, 127), quantity: "1", unitAmount: usd(input.amountCents) }],
              },
            ],
            paymentSource: {
              paypal: {
                experienceContext: {
                  brandName: input.brandName.slice(0, 127),
                  returnUrl: input.returnUrl,
                  cancelUrl: input.cancelUrl,
                  userAction: PaypalExperienceUserAction.PayNow,
                  shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                },
              },
            },
          },
          paypalRequestId: input.requestId,
          prefer: REPRESENTATION,
        });
        return toOrder(result, operation);
      });
    },

    getOrder(orderId) {
      const operation = "get order";
      return call(operation, async () => toOrder((await ordersApi.getOrder({ id: orderId })).result, operation));
    },

    authorizeOrder(orderId, requestId) {
      const operation = "authorize order";
      return call(operation, async () => {
        const { result } = await ordersApi.authorizeOrder({ id: orderId, paypalRequestId: requestId, prefer: REPRESENTATION, body: {} });
        const auth = result.purchaseUnits?.[0]?.payments?.authorizations?.[0];
        if (!auth) throw invalidResponse(operation, "the response has no authorization");
        return toAuthorization(auth, operation);
      });
    },

    captureOrder(orderId, requestId) {
      const operation = "capture order";
      return call(operation, async () => {
        await tokens.get(); // a credential failure surfaces here, as the token request's, before anything is sent
        const { result } = await ordersApi.captureOrder({ id: orderId, paypalRequestId: requestId, prefer: REPRESENTATION, body: {} });
        const capture = result.purchaseUnits?.[0]?.payments?.captures?.[0];
        if (!capture) throw invalidResponse(operation, "the response has no capture");
        return toCapture(capture, true, operation);
      });
    },

    getAuthorization(authorizationId) {
      const operation = "get authorization";
      return call(operation, async () => toAuthorization((await paymentsApi.getAuthorizedPayment({ authorizationId })).result, operation));
    },

    reauthorize(authorizationId, amountCents, requestId) {
      const operation = "reauthorize";
      return call(operation, async () => {
        const { result } = await paymentsApi.reauthorizePayment({
          authorizationId,
          paypalRequestId: requestId,
          prefer: REPRESENTATION,
          body: { amount: usd(amountCents) },
        });
        return toAuthorization(result, operation);
      });
    },

    captureAuthorization(authorizationId, input) {
      const operation = "capture authorization";
      return call(operation, async () => {
        const { result } = await paymentsApi.captureAuthorizedPayment({
          authorizationId,
          paypalRequestId: input.requestId,
          prefer: REPRESENTATION,
          body: {
            amount: usd(input.amountCents),
            finalCapture: input.finalCapture,
            invoiceId: input.invoiceId.slice(0, 127),
            noteToPayer: input.noteToPayer.slice(0, 255),
          },
        });
        return toCapture(result, input.finalCapture, operation);
      });
    },

    async voidAuthorization(authorizationId, requestId) {
      await call("void authorization", () =>
        paymentsApi.voidPayment({ authorizationId, paypalRequestId: requestId, prefer: "return=minimal" }),
      );
    },

    createPayoutBatch(input) {
      const operation = "create payout batch";
      return call(operation, async () => {
        const body = {
          sender_batch_header: {
            sender_batch_id: input.senderBatchId,
            recipient_type: "EMAIL",
            email_subject: input.emailSubject,
            email_message: input.note,
          },
          items: input.items.map((item) => ({
            recipient_type: "EMAIL",
            amount: { value: centsToValue(item.amountCents), currency: CURRENCY },
            note: item.note,
            sender_item_id: item.senderItemId,
            receiver: item.receiverEmail,
          })),
        };
        const json = await rest(operation, "POST", "/v1/payments/payouts", body, input.senderBatchId);
        const parsed = payoutCreateSchema.safeParse(json);
        if (!parsed.success) throw invalidResponse(operation, "unexpected payout response");
        const header = parsed.data.batch_header;
        const batch: PaypalPayoutBatch = {
          batchId: header.payout_batch_id,
          status: header.batch_status,
          items: input.items.map((item) => ({
            senderItemId: item.senderItemId,
            payoutItemId: null,
            status: "PENDING",
            amountCents: item.amountCents,
            feeCents: null,
          })),
        };
        return batch;
      });
    },

    getPayoutBatch(batchId) {
      const operation = "get payout batch";
      return call(operation, async () => {
        const json = await rest(operation, "GET", `/v1/payments/payouts/${encodeURIComponent(batchId)}`);
        const parsed = payoutBatchSchema.safeParse(json);
        if (!parsed.success) throw invalidResponse(operation, "unexpected payout batch response");
        const { batch_header: header, items = [] } = parsed.data;
        const batch: PaypalPayoutBatch = {
          batchId: header.payout_batch_id,
          status: header.batch_status,
          items: items.map((item) => ({
            senderItemId: item.payout_item?.sender_item_id ?? "",
            payoutItemId: item.payout_item_id ?? null,
            status: item.transaction_status ?? "PENDING",
            amountCents: item.payout_item?.amount ? valueToCents(item.payout_item.amount.value) : 0,
            feeCents: item.payout_item_fee ? valueToCents(item.payout_item_fee.value) : null,
          })),
        };
        return batch;
      });
    },

    // ------------------------------------------------------------ Disputes v1

    listDisputes(input = {}) {
      const operation = "list disputes";
      return call(operation, async () => {
        const out: PaypalDisputeSummary[] = [];
        for (let page = 1; page <= DISPUTE_MAX_PAGES; page++) {
          const json = await rest(operation, "GET", "/v1/customer/disputes", undefined, undefined, {
            query: {
              page_size: DISPUTE_PAGE_SIZE,
              page,
              update_time_after: input.updatedAfter != null ? new Date(input.updatedAfter).toISOString() : undefined,
              disputed_transaction_id: input.disputedTransactionId ?? undefined,
            },
          });
          const items = arrayOf(recordOf(json)?.items);
          for (const item of items) {
            const summary = toDisputeSummary(item);
            if (summary) out.push(summary);
          }
          const hasNext = arrayOf(recordOf(json)?.links).some((l) => recordOf(l)?.rel === "next");
          if (items.length < DISPUTE_PAGE_SIZE || !hasNext) break;
        }
        return out;
      });
    },

    getDispute(disputeId) {
      const operation = "get dispute";
      return call(operation, async () => {
        const dispute = toDispute(await rest(operation, "GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`));
        if (!dispute) throw invalidResponse(operation, "unexpected dispute response");
        return dispute;
      });
    },

    async provideDisputeEvidence(disputeId, input) {
      const evidence: Record<string, unknown> = { evidence_type: input.evidenceType ?? "OTHER", notes: input.notes.slice(0, DISPUTE_TEXT_MAX) };
      if (input.refundIds?.length) evidence.evidence_info = { refund_ids: input.refundIds };
      const operation = "provide dispute evidence";
      await call(operation, () => disputeAction(operation, disputeId, "provide-evidence", { evidences: [evidence] }, ["multipart"]));
    },

    async sendDisputeMessage(disputeId, message) {
      const operation = "send dispute message";
      await call(operation, () => disputeAction(operation, disputeId, "send-message", { message: message.slice(0, DISPUTE_TEXT_MAX) }, ["multipart", "json"]));
    },

    async makeDisputeOffer(disputeId, input) {
      const operation = "make dispute offer";
      const body: Record<string, unknown> = { note: input.note.slice(0, DISPUTE_TEXT_MAX), offer_amount: usdRest(input.amountCents), offer_type: "REFUND" };
      if (input.invoiceId) body.invoice_id = input.invoiceId.slice(0, 127);
      await call(operation, () => disputeAction(operation, disputeId, "make-offer", body, ["json"]));
    },

    async acceptDisputeClaim(disputeId, input) {
      const operation = "accept dispute claim";
      const body: Record<string, unknown> = { note: input.note.slice(0, DISPUTE_TEXT_MAX) };
      if (input.refundCents != null) {
        body.accept_claim_type = "PARTIAL_REFUND";
        body.refund_amount = usdRest(input.refundCents);
      } else {
        body.accept_claim_type = "REFUND";
      }
      if (input.invoiceId) body.invoice_id = input.invoiceId.slice(0, 127);
      await call(operation, () => disputeAction(operation, disputeId, "accept-claim", body, ["json", "multipart"]));
    },

    async escalateDispute(disputeId, note) {
      const operation = "escalate dispute";
      await call(operation, () => disputeAction(operation, disputeId, "escalate", { note: note.slice(0, DISPUTE_TEXT_MAX) }, ["json"]));
    },

    async adjudicateDispute(disputeId, outcome) {
      const operation = "adjudicate dispute";
      await call(operation, () => disputeAction(operation, disputeId, "adjudicate", { adjudication_outcome: outcome }, ["json"]));
    },

    async requireDisputeEvidence(disputeId, action) {
      const operation = "require dispute evidence";
      await call(operation, () => disputeAction(operation, disputeId, "require-evidence", { action }, ["json"]));
    },

    // ------------------------------------------------------------ Payments v2 refunds

    refundCapture(captureId, input) {
      const operation = "refund capture";
      return call(operation, async () => {
        await tokens.get(); // a credential failure surfaces here, as the token request's, before anything is sent
        const { result } = await paymentsApi.refundCapturedPayment({
          captureId,
          paypalRequestId: input.requestId,
          prefer: REPRESENTATION,
          body: {
            ...(input.amountCents != null ? { amount: usd(input.amountCents) } : {}),
            invoiceId: input.invoiceId.slice(0, 127),
            ...(input.noteToPayer ? { noteToPayer: input.noteToPayer.slice(0, 255) } : {}),
          },
        });
        if (!result.id) throw invalidResponse(operation, "the refund has no id");
        return { id: result.id, status: result.status ?? "UNKNOWN", amountCents: result.amount ? valueToCents(result.amount.value) : (input.amountCents ?? null) };
      });
    },

    // ------------------------------------------------------------ Invoicing v2

    createInvoiceRecord(input) {
      const operation = "create invoice record";
      return call(operation, async () => {
        let invoiceId: string | null = null;
        try {
          invoiceId = invoiceIdOf(await rest(operation, "POST", "/v2/invoicing/invoices", draftInvoiceBody(input), input.requestId, { prefer: REPRESENTATION }));
        } catch (err) {
          // An earlier attempt created the draft (same invoice number): carry on with that one.
          if (!(err instanceof PaypalError && err.hasIssue("DUPLICATE_INVOICE_NUMBER"))) throw err;
        }
        invoiceId ??= await findInvoiceId(operation, input.invoiceNumber);
        if (!invoiceId) throw invalidResponse(operation, "PayPal created no invoice id");

        let invoice = await getInvoice(operation, invoiceId);
        let payerView: string | null = null;
        if (invoice.status === "DRAFT") {
          // A share link rather than PayPal's email: the charge is already paid.
          const link = recordOf(
            await rest(operation, "POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, { send_to_invoicer: false, send_to_recipient: false }),
          );
          payerView = typeof link?.href === "string" ? link.href : null;
          invoice = await getInvoice(operation, invoiceId);
        }
        if (!PAID_INVOICE_STATUSES.has(invoice.status)) {
          await rest(operation, "POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/payments`, {
            method: "PAYPAL",
            amount: usdRest(input.amountCents),
            note: input.paymentNote.slice(0, 2_000),
          });
          invoice = await getInvoice(operation, invoiceId);
        }
        return { ...invoice, url: invoice.url ?? payerView };
      });
    },
  };

  async function findInvoiceId(operation: string, invoiceNumber: string): Promise<string | null> {
    const json = await rest(operation, "POST", "/v2/invoicing/search-invoices", { invoice_number: invoiceNumber }, undefined, { query: { page_size: 5 } });
    const match = arrayOf(recordOf(json)?.items)
      .map(recordOf)
      .find((item) => recordOf(item?.detail)?.invoice_number === invoiceNumber);
    return typeof match?.id === "string" ? match.id : null;
  }
}

// ---------------------------------------------------------------- response mapping

const payoutMoneySchema = z.object({ value: z.string(), currency: z.string().optional() });

const payoutCreateSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string().min(1), batch_status: z.string().min(1) }),
});

const payoutBatchSchema = z.object({
  batch_header: z.object({ payout_batch_id: z.string().min(1), batch_status: z.string().min(1) }),
  items: z
    .array(
      z.object({
        payout_item_id: z.string().optional(),
        transaction_status: z.string().optional(),
        payout_item_fee: payoutMoneySchema.optional(),
        payout_item: z
          .object({ sender_item_id: z.string().optional(), amount: payoutMoneySchema.optional() })
          .optional(),
      }),
    )
    .optional(),
});

function invalidResponse(operation: string, message: string): PaypalError {
  return new PaypalError({ operation, paypalName: "INVALID_RESPONSE", message });
}

/** The link the payer approves at: `payer-action` (payment_source flow) or the legacy `approve`. */
export function approveLink(links: LinkDescription[] | undefined): string | null {
  return links?.find((l) => l.rel === "payer-action")?.href ?? links?.find((l) => l.rel === "approve")?.href ?? null;
}

function toOrder(order: Order, operation: string): PaypalOrder {
  if (!order.id) throw invalidResponse(operation, "the order has no id");
  const payerEmail = order.paymentSource?.paypal?.emailAddress ?? order.payer?.emailAddress ?? null;
  const payments = order.purchaseUnits?.[0]?.payments;
  const captureId = payments?.captures?.[0]?.id ?? null;
  const refunds = (payments?.refunds ?? []).flatMap((r) =>
    r.id
      ? [{ id: r.id, status: r.status ?? "UNKNOWN", amountCents: r.amount ? valueToCents(r.amount.value) : null, invoiceId: r.invoiceId ?? null }]
      : [],
  );
  return {
    id: order.id,
    status: order.status ?? "UNKNOWN",
    approveUrl: approveLink(order.links),
    ...(payerEmail ? { payerEmail } : {}),
    ...(captureId ? { captureId } : {}),
    ...(refunds.length ? { refunds } : {}),
  };
}

function parseTime(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function toAuthorization(auth: PaymentAuthorization | AuthorizationWithAdditionalData, operation: string): PaypalAuthorization {
  if (!auth.id) throw invalidResponse(operation, "the authorization has no id");
  return {
    id: auth.id,
    status: auth.status ?? "UNKNOWN",
    amountCents: auth.amount ? valueToCents(auth.amount.value) : 0,
    expiresAt: parseTime(auth.expirationTime),
  };
}

function toCapture(capture: CapturedPayment | OrdersCapture, finalCapture: boolean, operation: string): PaypalCapture {
  if (!capture.id) throw invalidResponse(operation, "the capture has no id");
  const fee = capture.sellerReceivableBreakdown?.paypalFee;
  return {
    id: capture.id,
    status: capture.status ?? "UNKNOWN",
    amountCents: capture.amount ? valueToCents(capture.amount.value) : 0,
    feeCents: fee ? valueToCents(fee.value) : null,
    finalCapture: capture.finalCapture ?? finalCapture,
  };
}

// ---------------------------------------------------------------- Disputes v1 and Invoicing v2 (REST)

const DISPUTE_PAGE_SIZE = 50;
const DISPUTE_MAX_PAGES = 10;
/** notes, message and note fields allow 2000 characters. */
const DISPUTE_TEXT_MAX = 2_000;
const PAID_INVOICE_STATUSES = new Set(["PAID", "MARKED_AS_PAID", "PAID_EXTERNAL"]);

const usdRest = (cents: number) => ({ currency_code: CURRENCY, value: centsToValue(cents) });

type Json = Record<string, unknown>;

function recordOf(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** A PayPal money object in cents, or null when absent or unreadable. */
function centsOf(money: unknown): number | null {
  const value = recordOf(money)?.value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  try {
    return Math.abs(valueToCents(String(value)));
  } catch {
    return null;
  }
}

function timeOf(value: unknown): number | null {
  return typeof value === "string" ? parseTime(value) : null;
}

/**
 * HATEOAS links -> the actions PayPal allows, snake_case ("provide-evidence" href or rel -> provide_evidence).
 * `self` and plain GETs are not actions.
 */
export function disputeActionsOf(links: unknown): string[] {
  const out = new Set<string>();
  for (const raw of arrayOf(links)) {
    const link = recordOf(raw);
    if (!link || String(link.method ?? "POST").toUpperCase() === "GET") continue;
    const rel = textOf(link.rel);
    const fromHref = textOf(link.href)?.split("?")[0]?.split("/").pop() ?? null;
    for (const name of [rel, fromHref]) {
      if (!name || name === "self") continue;
      const action = name.toLowerCase().replace(/-/g, "_");
      if (/^[a-z_]+$/.test(action)) out.add(action);
    }
  }
  return [...out];
}

function toDisputeSummary(raw: unknown): PaypalDisputeSummary | null {
  const d = recordOf(raw);
  const id = textOf(d?.dispute_id);
  if (!d || !id) return null;
  return {
    id,
    status: textOf(d.status) ?? "OTHER",
    reason: textOf(d.reason) ?? "OTHER",
    stage: textOf(d.dispute_life_cycle_stage),
    amountCents: centsOf(d.dispute_amount) ?? 0,
    createdAt: timeOf(d.create_time),
    updatedAt: timeOf(d.update_time),
  };
}

/** Money back to the buyer per PayPal: the outcome's amount_refunded, else the seller's settlement debits, else refunds. */
function refundedCentsOf(d: Json): number | null {
  const outcome = centsOf(recordOf(d.dispute_outcome)?.amount_refunded);
  if (outcome !== null) return outcome;
  const debits = arrayOf(d.money_movements)
    .map(recordOf)
    .filter((m) => m?.affected_party === "SELLER" && m.type === "DEBIT" && (m.reason == null || m.reason === "DISPUTE_SETTLEMENT"));
  if (debits.length > 0) return debits.reduce((sum, m) => sum + (centsOf(m?.amount) ?? 0), 0);
  const refunds = arrayOf(recordOf(d.refund_details)?.transactions).map(recordOf);
  if (refunds.length > 0) return refunds.reduce((sum, t) => sum + (centsOf(t?.gross_amount) ?? 0), 0);
  return null;
}

export function toDispute(raw: unknown): PaypalDispute | null {
  const summary = toDisputeSummary(raw);
  const d = recordOf(raw);
  if (!summary || !d) return null;
  const captureIds = arrayOf(d.disputed_transactions)
    .map((t) => textOf(recordOf(t)?.seller_transaction_id))
    .filter((id): id is string => id !== null);
  const buyerMessages = arrayOf(d.messages)
    .map(recordOf)
    .filter((m) => m?.posted_by === "BUYER" && textOf(m.content))
    .sort((a, b) => (timeOf(a?.time_posted) ?? 0) - (timeOf(b?.time_posted) ?? 0));
  const requestedEvidence = arrayOf(d.evidences)
    .map(recordOf)
    .filter((e) => e?.source === "REQUESTED_FROM_SELLER")
    .map((e) => textOf(e?.evidence_type))
    .filter((type): type is string => type !== null);
  return {
    ...summary,
    captureIds,
    outcome: textOf(recordOf(d.dispute_outcome)?.outcome_code),
    refundedCents: refundedCentsOf(d),
    buyerMessage: textOf(buyerMessages.at(-1)?.content)?.slice(0, 2_000) ?? null,
    sellerResponseDueAt: timeOf(d.seller_response_due_date),
    actions: disputeActionsOf(d.links),
    requestedEvidence,
  };
}

/** PayPal refused the request body's encoding itself (so nothing happened and the other encoding may work). */
function rejectedEncoding(err: PaypalError): boolean {
  return (
    err.httpStatus === 415 ||
    err.hasIssue("MISSING_OR_INVALID_REQUEST_BODY", "MALFORMED_REQUEST", "MALFORMED_REQUEST_JSON", "INVALID_REQUEST_BODY", "UNSUPPORTED_MEDIA_TYPE", "INVALID_CONTENT_TYPE")
  );
}

/**
 * multipart/form-data with one `input` part of type application/json and no filename: the shape of PayPal's
 * documented `curl -F 'input={...};type=application/json'`.
 */
export function multipartInput(input: unknown): { body: string; contentType: string } {
  const boundary = `----p402-${randomBytes(12).toString("hex")}`;
  const body =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="input"\r\n' +
    "Content-Type: application/json\r\n\r\n" +
    `${JSON.stringify(input)}\r\n` +
    `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function draftInvoiceBody(input: PaypalInvoiceInput): Json {
  const body: Json = {
    detail: {
      invoice_number: input.invoiceNumber.slice(0, 25),
      reference: input.reference.slice(0, 120),
      currency_code: CURRENCY,
      note: input.note.slice(0, 4_000),
      memo: input.memo.slice(0, 500),
      payment_term: { term_type: "DUE_ON_RECEIPT" },
    },
    invoicer: { business_name: "402 Fiatality" },
    items: [
      {
        name: input.itemName.slice(0, 200),
        description: input.itemDescription.slice(0, 1_000),
        quantity: "1",
        unit_amount: usdRest(input.amountCents),
        unit_of_measure: "AMOUNT",
      },
    ],
  };
  if (input.recipientEmail) body.primary_recipients = [{ billing_info: { email_address: input.recipientEmail } }];
  return body;
}

/** The draft's id: the invoice itself (Prefer: return=representation) or the link PayPal answers with otherwise. */
function invoiceIdOf(json: unknown): string | null {
  const record = recordOf(json);
  const id = textOf(record?.id);
  if (id) return id;
  const href = textOf(record?.href);
  return href ? (href.split("?")[0]?.split("/").pop() ?? null) : null;
}

function toInvoice(json: unknown): PaypalInvoice | null {
  const invoice = recordOf(json);
  const id = textOf(invoice?.id);
  if (!invoice || !id) return null;
  const detail = recordOf(invoice.detail);
  const metadata = recordOf(detail?.metadata);
  return {
    id,
    invoiceNumber: textOf(detail?.invoice_number) ?? "",
    status: textOf(invoice.status) ?? "UNKNOWN",
    amountCents: centsOf(invoice.amount) ?? 0,
    url: textOf(metadata?.recipient_view_url),
  };
}
