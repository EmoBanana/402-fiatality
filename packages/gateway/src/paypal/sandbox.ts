/**
 * PaypalClient against the PayPal sandbox (SPEC §6.1).
 *
 * Orders v2 and Payments v2 go through `@paypal/paypal-server-sdk` (OrdersController, PaymentsController).
 * Payouts v1 is not in the SDK, so it is plain REST with the same cached OAuth token. Every mutating call
 * sends `PayPal-Request-Id` (callers derive it from our ids, so retries are idempotent) and asks for
 * `Prefer: return=representation` so captures include `seller_receivable_breakdown.paypal_fee`.
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
import { centsToValue, valueToCents } from "@p402/shared";
import { z } from "zod";
import {
  AppError,
  type AppConfig,
  type Logger,
  type PaypalAuthorization,
  type PaypalCapture,
  type PaypalClient,
  type PaypalOrder,
  type PaypalPayoutBatch,
} from "../context";
import { PaypalError, paypalErrorFromResponse, toPaypalError } from "./errors";
import { createTokenSource, PAYPAL_SANDBOX_API, type TokenSource } from "./oauth";

export type SdkOrders = Pick<OrdersController, "createOrder" | "getOrder" | "authorizeOrder" | "captureOrder">;
export type SdkPayments = Pick<
  PaymentsController,
  "getAuthorizedPayment" | "captureAuthorizedPayment" | "reauthorizePayment" | "voidPayment"
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

  async function rest(operation: string, method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<unknown> {
    const token = await tokens.get();
    const headers: Record<string, string> = {
      authorization: `Bearer ${token.value}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (requestId) headers["paypal-request-id"] = requestId;
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toPaypalError(err, operation);
    }
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw paypalErrorFromResponse(operation, res.status, json, res.headers);
    return json;
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
  };
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
  return { id: order.id, status: order.status ?? "UNKNOWN", approveUrl: approveLink(order.links) };
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
