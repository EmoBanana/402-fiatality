/**
 * Offline PaypalClient (PAYPAL_MODE=mock) with PayPal's rules for holds: approve -> authorize (3-day honor
 * window, 29-day expiry) -> one reauthorization after the honor window -> captures up to 115% / +$75 ->
 * void. Fees follow the published US rates (`captureFeeCents`, $0.25 per payout); payouts succeed at once.
 *
 * State is persisted as JSON rows in `kv` under `mockpaypal:` because tabs in SQLite reference mock order
 * and authorization ids across gateway restarts. `PayPal-Request-Id` is honored: repeating a request id
 * returns the first successful response (failures are not cached, so they can be retried).
 */
import { randomBytes } from "node:crypto";
import { captureFeeCents, PAYPAL_US_FEES } from "@p402/shared";
import type {
  AppConfig,
  Clock,
  Db,
  Logger,
  PaypalAuthorization,
  PaypalCapture,
  PaypalClient,
  PaypalOrder,
  PaypalPayoutBatch,
  PaypalPayoutItem,
} from "../context";
import { DAY_MS } from "../clock";
import { kvGet, kvSet, parseJson, tx } from "../db/db";
import { PaypalError } from "./errors";

const PREFIX = "mockpaypal:";
export const HONOR_PERIOD_MS = 3 * DAY_MS;
export const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;
/** US rule: a capture or reauthorization may exceed the original amount by 15%, at most $75. */
export function maxOverCaptureCents(amountCents: number): number {
  return Math.min(Math.floor((amountCents * 115) / 100), amountCents + 7_500);
}

export type MockOrderStatus = "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";

export interface MockOrder {
  id: string;
  intent: "AUTHORIZE" | "CAPTURE";
  status: MockOrderStatus;
  amountCents: number;
  referenceId: string;
  description: string;
  itemName: string | null;
  brandName: string;
  returnUrl: string;
  cancelUrl: string;
  authorizationId: string | null;
  captureId: string | null;
  createdAt: number;
}

interface MockAuthorization {
  id: string;
  orderId: string;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED";
  amountCents: number;
  capturedCents: number;
  /** Held amount given back to the payer by a final capture or a void. */
  releasedCents: number;
  createdAt: number;
  honorUntil: number;
  expiresAt: number;
  reauthorizedFrom: string | null;
  reauthorizedTo: string | null;
  captureIds: string[];
}

interface MockCapture {
  id: string;
  authorizationId: string | null;
  orderId: string | null;
  status: "COMPLETED";
  amountCents: number;
  feeCents: number;
  finalCapture: boolean;
  invoiceId: string | null;
  createdAt: number;
}

interface MockBatch {
  batchId: string;
  senderBatchId: string;
  status: "SUCCESS";
  items: PaypalPayoutItem[];
  createdAt: number;
}

export interface MockPaypalDeps {
  config: Pick<AppConfig, "publicBaseUrl">;
  db: Db;
  log: Logger;
  /** The gateway clock (so the demo fast-forward ages holds); real time when absent. */
  clock?: Pick<Clock, "now">;
}

const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Plausible-looking mock ids, e.g. MOCK-ORDER-7KQ2M9XW4HTR. */
export function mockId(kind: "ORDER" | "AUTH" | "CAPTURE" | "BATCH" | "ITEM"): string {
  let out = "";
  for (const byte of randomBytes(12)) out += ID_ALPHABET[byte % ID_ALPHABET.length];
  return `MOCK-${kind}-${out}`;
}

export function mockApproveUrl(publicBaseUrl: string, orderId: string): string {
  return `${publicBaseUrl}/paypal/mock/approve?token=${encodeURIComponent(orderId)}`;
}

// ---------------------------------------------------------------- persistence

const keyOf = (kind: string, id: string) => `${PREFIX}${kind}:${id}`;

function load<T>(db: Db, kind: string, id: string): T | null {
  return parseJson<T | null>(kvGet(db, keyOf(kind, id)), null);
}

function save(db: Db, kind: string, id: string, value: unknown): void {
  kvSet(db, keyOf(kind, id), JSON.stringify(value));
}

/** The mock order behind a `token`, for the mock approval page. */
export function getMockOrder(db: Db, orderId: string): MockOrder | null {
  return load<MockOrder>(db, "order", orderId);
}

/** The payer clicked Approve on the mock page. Idempotent; null when the order does not exist. */
export function approveMockOrder(db: Db, orderId: string): MockOrder | null {
  return tx(db, () => {
    const order = getMockOrder(db, orderId);
    if (!order) return null;
    if (order.status === "PAYER_ACTION_REQUIRED") {
      order.status = "APPROVED";
      save(db, "order", order.id, order);
    }
    return order;
  });
}

// ---------------------------------------------------------------- client

export function createMockPaypal(deps: MockPaypalDeps): PaypalClient {
  const { db, log } = deps;
  const now = () => deps.clock?.now() ?? Date.now();

  function fail(operation: string, status: number, name: string, issue: string, description: string): never {
    const error = new PaypalError({
      operation,
      paypalName: name,
      message: description,
      debugId: `mock-${randomBytes(6).toString("hex")}`,
      issues: [{ issue, description }],
      httpStatus: status,
    });
    log.warn(error.toLog(), "PayPal call failed (mock)");
    throw error;
  }

  const unprocessable = (operation: string, issue: string, description: string) =>
    fail(operation, 422, "UNPROCESSABLE_ENTITY", issue, description);
  const notFound = (operation: string, what: string) =>
    fail(operation, 404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", `Specified resource ID does not exist (${what}).`);

  /** Run a mutation atomically; a repeated PayPal-Request-Id returns the first successful result. */
  function mutate<T>(operation: string, requestId: string, fn: () => T): T {
    return tx(db, () => {
      const cacheKey = keyOf(`req:${operation}`, requestId);
      const cached = kvGet(db, cacheKey);
      if (cached != null) return JSON.parse(cached) as T;
      const result = fn();
      kvSet(db, cacheKey, JSON.stringify(result));
      return result;
    });
  }

  const orderView = (order: MockOrder): PaypalOrder => ({
    id: order.id,
    status: order.status,
    approveUrl: order.status === "PAYER_ACTION_REQUIRED" ? mockApproveUrl(deps.config.publicBaseUrl, order.id) : null,
  });

  /** Expiry is evaluated lazily, like PayPal reporting EXPIRED once the 29 days are over. */
  const isExpired = (auth: MockAuthorization) =>
    (auth.status === "CREATED" || auth.status === "PARTIALLY_CAPTURED") && now() >= auth.expiresAt;

  const authView = (auth: MockAuthorization): PaypalAuthorization => ({
    id: auth.id,
    status: isExpired(auth) ? "EXPIRED" : auth.status,
    amountCents: auth.amountCents,
    expiresAt: auth.expiresAt,
  });

  const captureView = (capture: MockCapture): PaypalCapture => ({
    id: capture.id,
    status: capture.status,
    amountCents: capture.amountCents,
    feeCents: capture.feeCents,
    finalCapture: capture.finalCapture,
  });

  function requireOrder(operation: string, orderId: string): MockOrder {
    return getMockOrder(db, orderId) ?? notFound(operation, `order ${orderId}`);
  }

  function requireCapturable(operation: string, authorizationId: string): MockAuthorization {
    const auth = load<MockAuthorization>(db, "auth", authorizationId) ?? notFound(operation, `authorization ${authorizationId}`);
    if (auth.status === "VOIDED") unprocessable(operation, "AUTHORIZATION_VOIDED", "The authorization has been voided.");
    if (auth.status === "CAPTURED") unprocessable(operation, "AUTHORIZATION_ALREADY_CAPTURED", "The authorization has already been captured.");
    if (isExpired(auth)) unprocessable(operation, "AUTHORIZATION_EXPIRED", "The authorization has expired.");
    return auth;
  }

  function createOrder(
    operation: string,
    intent: MockOrder["intent"],
    input: { referenceId: string; amountCents: number; description: string; itemName: string | null; brandName: string; returnUrl: string; cancelUrl: string; requestId: string },
  ): PaypalOrder {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
      unprocessable(operation, "CANNOT_BE_ZERO_OR_NEGATIVE", "The amount must be greater than zero.");
    }
    return mutate(operation, input.requestId, () => {
      const order: MockOrder = {
        id: mockId("ORDER"),
        intent,
        status: "PAYER_ACTION_REQUIRED",
        amountCents: input.amountCents,
        referenceId: input.referenceId,
        description: input.description,
        itemName: input.itemName,
        brandName: input.brandName,
        returnUrl: input.returnUrl,
        cancelUrl: input.cancelUrl,
        authorizationId: null,
        captureId: null,
        createdAt: now(),
      };
      save(db, "order", order.id, order);
      return orderView(order);
    });
  }

  function newCapture(input: Omit<MockCapture, "id" | "status" | "feeCents" | "createdAt">): MockCapture {
    const capture: MockCapture = {
      ...input,
      id: mockId("CAPTURE"),
      status: "COMPLETED",
      feeCents: captureFeeCents(input.amountCents),
      createdAt: now(),
    };
    save(db, "capture", capture.id, capture);
    if (capture.invoiceId) kvSet(db, keyOf("invoice", capture.invoiceId), capture.id);
    return capture;
  }

  return {
    mode: "mock",

    async createAuthorizeOrder(input) {
      return createOrder("create hold order", "AUTHORIZE", { ...input, itemName: null });
    },

    async createCaptureOrder(input) {
      return createOrder("create purchase order", "CAPTURE", input);
    },

    async getOrder(orderId) {
      return orderView(requireOrder("get order", orderId));
    },

    async authorizeOrder(orderId, requestId) {
      const operation = "authorize order";
      return mutate(operation, requestId, () => {
        const order = requireOrder(operation, orderId);
        if (order.intent !== "AUTHORIZE") unprocessable(operation, "ACTION_DOES_NOT_MATCH_INTENT", "The order intent is CAPTURE.");
        if (order.status === "PAYER_ACTION_REQUIRED") unprocessable(operation, "ORDER_NOT_APPROVED", "The payer has not approved the order.");
        if (order.status === "COMPLETED") unprocessable(operation, "ORDER_ALREADY_AUTHORIZED", "The order has already been authorized.");
        const at = now();
        const auth: MockAuthorization = {
          id: mockId("AUTH"),
          orderId: order.id,
          status: "CREATED",
          amountCents: order.amountCents,
          capturedCents: 0,
          releasedCents: 0,
          createdAt: at,
          honorUntil: at + HONOR_PERIOD_MS,
          expiresAt: at + AUTHORIZATION_VALIDITY_MS,
          reauthorizedFrom: null,
          reauthorizedTo: null,
          captureIds: [],
        };
        save(db, "auth", auth.id, auth);
        save(db, "order", order.id, { ...order, status: "COMPLETED", authorizationId: auth.id });
        return authView(auth);
      });
    },

    async captureOrder(orderId, requestId) {
      const operation = "capture order";
      return mutate(operation, requestId, () => {
        const order = requireOrder(operation, orderId);
        if (order.intent !== "CAPTURE") unprocessable(operation, "ACTION_DOES_NOT_MATCH_INTENT", "The order intent is AUTHORIZE.");
        if (order.status === "PAYER_ACTION_REQUIRED") unprocessable(operation, "ORDER_NOT_APPROVED", "The payer has not approved the order.");
        if (order.status === "COMPLETED") unprocessable(operation, "ORDER_ALREADY_CAPTURED", "The order has already been captured.");
        const capture = newCapture({ authorizationId: null, orderId: order.id, amountCents: order.amountCents, finalCapture: true, invoiceId: null });
        save(db, "order", order.id, { ...order, status: "COMPLETED", captureId: capture.id });
        return captureView(capture);
      });
    },

    async getAuthorization(authorizationId) {
      const auth = load<MockAuthorization>(db, "auth", authorizationId) ?? notFound("get authorization", `authorization ${authorizationId}`);
      return authView(auth);
    },

    async reauthorize(authorizationId, amountCents, requestId) {
      const operation = "reauthorize";
      return mutate(operation, requestId, () => {
        const original = requireCapturable(operation, authorizationId);
        if (original.reauthorizedTo || original.reauthorizedFrom) {
          unprocessable(operation, "REAUTHORIZATION_LIMIT_REACHED", "Mock PayPal: this hold was already reauthorized once.");
        }
        if (original.capturedCents > 0) unprocessable(operation, "AUTHORIZATION_ALREADY_CAPTURED", "The authorization has captures.");
        if (now() < original.honorUntil) {
          unprocessable(operation, "REAUTHORIZE_TOO_SOON", "Mock PayPal: reauthorize only after the 3-day honor period.");
        }
        if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
          unprocessable(operation, "CANNOT_BE_ZERO_OR_NEGATIVE", "The amount must be greater than zero.");
        }
        if (amountCents > maxOverCaptureCents(original.amountCents)) {
          unprocessable(operation, "MAX_AUTHORIZATION_AMOUNT_EXCEEDED", "At most 115% of the original amount (+$75).");
        }
        const at = now();
        const reauth: MockAuthorization = {
          ...original,
          id: mockId("AUTH"),
          status: "CREATED",
          amountCents,
          capturedCents: 0,
          releasedCents: 0,
          createdAt: at,
          honorUntil: at + HONOR_PERIOD_MS,
          // The 29 days run from the original authorization.
          expiresAt: original.expiresAt,
          reauthorizedFrom: original.id,
          reauthorizedTo: null,
          captureIds: [],
        };
        save(db, "auth", reauth.id, reauth);
        save(db, "auth", original.id, { ...original, reauthorizedTo: reauth.id });
        return authView(reauth);
      });
    },

    async captureAuthorization(authorizationId, input) {
      const operation = "capture authorization";
      return mutate(operation, input.requestId, () => {
        const auth = requireCapturable(operation, authorizationId);
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
          unprocessable(operation, "CANNOT_BE_ZERO_OR_NEGATIVE", "The amount must be greater than zero.");
        }
        if (auth.capturedCents + input.amountCents > maxOverCaptureCents(auth.amountCents)) {
          unprocessable(operation, "MAX_CAPTURE_AMOUNT_EXCEEDED", "Captures may exceed the authorization by at most 115% (+$75).");
        }
        if (input.invoiceId && kvGet(db, keyOf("invoice", input.invoiceId)) != null) {
          unprocessable(operation, "DUPLICATE_INVOICE_ID", "The invoice id was already used.");
        }
        const capture = newCapture({
          authorizationId: auth.id,
          orderId: auth.orderId,
          amountCents: input.amountCents,
          finalCapture: input.finalCapture,
          invoiceId: input.invoiceId || null,
        });
        const capturedCents = auth.capturedCents + input.amountCents;
        const done = input.finalCapture || capturedCents >= auth.amountCents;
        save(db, "auth", auth.id, {
          ...auth,
          capturedCents,
          status: done ? "CAPTURED" : "PARTIALLY_CAPTURED",
          releasedCents: done ? Math.max(0, auth.amountCents - capturedCents) : 0,
          captureIds: [...auth.captureIds, capture.id],
        } satisfies MockAuthorization);
        return captureView(capture);
      });
    },

    async voidAuthorization(authorizationId, requestId) {
      const operation = "void authorization";
      mutate(operation, requestId, () => {
        const auth = requireCapturable(operation, authorizationId);
        save(db, "auth", auth.id, { ...auth, status: "VOIDED", releasedCents: auth.amountCents - auth.capturedCents } satisfies MockAuthorization);
        return { voided: auth.id };
      });
    },

    async createPayoutBatch(input) {
      const operation = "create payout batch";
      return mutate(operation, input.senderBatchId, () => {
        if (input.items.length === 0) unprocessable(operation, "VALIDATION_ERROR", "A payout needs at least one item.");
        if (kvGet(db, keyOf("sender-batch", input.senderBatchId)) != null) {
          unprocessable(operation, "DUPLICATE_SENDER_BATCH_ID", "A batch with this sender_batch_id already exists.");
        }
        for (const item of input.items) {
          if (!Number.isSafeInteger(item.amountCents) || item.amountCents <= 0) {
            unprocessable(operation, "VALIDATION_ERROR", `Item ${item.senderItemId} must be at least $0.01.`);
          }
        }
        const batch: MockBatch = {
          batchId: mockId("BATCH"),
          senderBatchId: input.senderBatchId,
          status: "SUCCESS",
          items: input.items.map((item) => {
            const deliverable = /^[^\s@]+@[^\s@]+$/.test(item.receiverEmail);
            return {
              senderItemId: item.senderItemId,
              payoutItemId: mockId("ITEM"),
              status: deliverable ? "SUCCESS" : "FAILED",
              amountCents: item.amountCents,
              feeCents: deliverable ? PAYPAL_US_FEES.payoutApiFlatCents : 0,
            };
          }),
          createdAt: now(),
        };
        save(db, "batch", batch.batchId, batch);
        kvSet(db, keyOf("sender-batch", input.senderBatchId), batch.batchId);
        return batchView(batch);
      });
    },

    async getPayoutBatch(batchId) {
      const batch = load<MockBatch>(db, "batch", batchId) ?? notFound("get payout batch", `payout batch ${batchId}`);
      return batchView(batch);
    },
  };
}

function batchView(batch: MockBatch): PaypalPayoutBatch {
  return { batchId: batch.batchId, status: batch.status, items: batch.items.map((item) => ({ ...item })) };
}

/** What a mock authorization looks like inside (tests check that holds are released). */
export function inspectMockAuthorization(db: Db, authorizationId: string): Readonly<MockAuthorization> | null {
  return load<MockAuthorization>(db, "auth", authorizationId);
}
