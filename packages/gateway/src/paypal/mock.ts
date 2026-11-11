/**
 * Offline PaypalClient (PAYPAL_MODE=mock) with PayPal's rules for holds: approve -> authorize (3-day honor
 * window, 29-day expiry) -> one reauthorization after the honor window -> captures up to 115% / +$75 ->
 * void. Fees follow the published US rates (`captureFeeCents`, $0.25 per payout); payouts succeed at once.
 *
 * State is persisted as JSON rows in `kv` under `mockpaypal:` because tabs in SQLite reference mock order
 * and authorization ids across gateway restarts. `PayPal-Request-Id` is honored: repeating a request id
 * returns the first successful response (failures are not cached, so they can be retried).
 *
 * Disputes follow PayPal's lifecycle on the demo clock: the buyer opens one on a capture (`openMockDispute`,
 * the stand-in for PayPal's Resolution Center) as an INQUIRY waiting for the seller, who has 10 days to respond
 * before it resolves in the buyer's favour. Evidence puts it UNDER_REVIEW; an offer is accepted by the mock
 * buyer at once; accepting the claim or adjudicating settles it. Refunds and invoices are recorded too.
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
  PaypalDispute,
  PaypalDisputeSummary,
  PaypalInvoice,
  PaypalOrder,
  PaypalPayoutBatch,
  PaypalPayoutItem,
} from "../context";
import { DAY_MS } from "../clock";
import { kvGet, kvSet, parseJson, stmt, tx } from "../db/db";
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
  /** Given back to the payer by refunds and disputes (absent on records from older builds). */
  refundedCents?: number;
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
export function mockId(kind: "ORDER" | "AUTH" | "CAPTURE" | "BATCH" | "ITEM" | "D" | "REFUND" | "INV"): string {
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
    ...(order.status === "PAYER_ACTION_REQUIRED" ? {} : { payerEmail: MOCK_PAYER_EMAIL }),
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

    // ------------------------------------------------------------ disputes

    async listDisputes(input = {}) {
      return tx(db, () =>
        allMockDisputes(db)
          .map((d) => aged(db, d, now()))
          .filter((d) => input.updatedAfter == null || d.updatedAt > input.updatedAfter)
          .filter((d) => !input.disputedTransactionId || d.captureId === input.disputedTransactionId)
          .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
          .map(disputeSummary),
      );
    },

    async getDispute(disputeId) {
      return tx(db, () => disputeView(aged(db, requireDispute("get dispute", disputeId), now())));
    },

    async provideDisputeEvidence(disputeId, input) {
      const operation = "provide dispute evidence";
      changeDispute(operation, disputeId, (d, at) => {
        if (d.status !== "WAITING_FOR_SELLER_RESPONSE") {
          unprocessable(operation, "NOT_ALLOWED_TO_PROVIDE_EVIDENCE", `Evidence is accepted only while PayPal waits for the seller (the dispute is ${d.status}).`);
        }
        if (!input.notes.trim()) unprocessable(operation, "MISSING_EVIDENCE", "Evidence needs notes or documents.");
        d.evidences.push({ type: input.evidenceType ?? "OTHER", notes: input.notes.slice(0, 2_000), at });
        d.status = "UNDER_REVIEW";
        d.sellerResponseDueAt = null;
      });
    },

    async sendDisputeMessage(disputeId, message) {
      const operation = "send dispute message";
      changeDispute(operation, disputeId, (d, at) => {
        if (d.stage !== "INQUIRY") unprocessable(operation, "NOT_AN_INQUIRY", "Messages can be sent only while the dispute is an inquiry.");
        if (!message.trim()) unprocessable(operation, "MISSING_MESSAGE", "The message is empty.");
        d.messages.push({ postedBy: "SELLER", content: message.slice(0, 2_000), at });
        d.status = "WAITING_FOR_BUYER_RESPONSE";
        d.sellerResponseDueAt = null;
      });
    },

    async makeDisputeOffer(disputeId, input) {
      const operation = "make dispute offer";
      changeDispute(operation, disputeId, (d, at) => {
        if (d.stage !== "INQUIRY") unprocessable(operation, "NOT_AN_INQUIRY", "Offers can be made only while the dispute is an inquiry.");
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > d.amountCents) {
          unprocessable(operation, "INVALID_OFFER_AMOUNT", "The offer must be between $0.01 and the disputed amount.");
        }
        d.offer = { amountCents: input.amountCents, note: input.note.slice(0, 2_000), at };
        // The mock buyer takes any refund offered, at once.
        d.messages.push({ postedBy: "BUYER", content: "I accept the refund offered.", at });
        resolveDispute(db, d, at, "RESOLVED_BUYER_FAVOUR", input.amountCents);
      });
    },

    async acceptDisputeClaim(disputeId, input) {
      const operation = "accept dispute claim";
      changeDispute(operation, disputeId, (d, at) => {
        const refund = input.refundCents ?? d.amountCents;
        if (!Number.isSafeInteger(refund) || refund <= 0 || refund > d.amountCents) {
          unprocessable(operation, "INVALID_REFUND_AMOUNT", "The refund must be between $0.01 and the disputed amount.");
        }
        if (input.note.trim()) d.messages.push({ postedBy: "SELLER", content: input.note.slice(0, 2_000), at });
        resolveDispute(db, d, at, "RESOLVED_BUYER_FAVOUR", refund);
      });
    },

    async escalateDispute(disputeId, note) {
      const operation = "escalate dispute";
      changeDispute(operation, disputeId, (d, at) => {
        if (d.stage !== "INQUIRY") unprocessable(operation, "NOT_AN_INQUIRY", "Only an inquiry can be escalated to a claim.");
        if (note.trim()) d.messages.push({ postedBy: "SELLER", content: note.slice(0, 2_000), at });
        d.stage = "CHARGEBACK";
        d.status = "UNDER_REVIEW";
        d.sellerResponseDueAt = null;
      });
    },

    async adjudicateDispute(disputeId, outcome) {
      // PayPal's sandbox settles only disputes UNDER_REVIEW; the offline demo settles any open one.
      changeDispute("adjudicate dispute", disputeId, (d, at) => {
        if (outcome === "BUYER_FAVOR") resolveDispute(db, d, at, "RESOLVED_BUYER_FAVOUR", d.amountCents);
        else resolveDispute(db, d, at, "RESOLVED_SELLER_FAVOUR", 0);
      });
    },

    async requireDisputeEvidence(disputeId, action) {
      const operation = "require dispute evidence";
      changeDispute(operation, disputeId, (d, at) => {
        if (d.status !== "UNDER_REVIEW") unprocessable(operation, "NOT_UNDER_REVIEW", "Only a dispute under review can ask for evidence.");
        d.status = action === "SELLER_EVIDENCE" ? "WAITING_FOR_SELLER_RESPONSE" : "WAITING_FOR_BUYER_RESPONSE";
        d.sellerResponseDueAt = action === "SELLER_EVIDENCE" ? at + SELLER_RESPONSE_DAYS * DAY_MS : null;
      });
    },

    // ------------------------------------------------------------ refunds & invoices

    async refundCapture(captureId, input) {
      const operation = "refund capture";
      return mutate(operation, input.requestId, () => {
        const capture = load<MockCapture>(db, "capture", captureId) ?? notFound(operation, `capture ${captureId}`);
        const left = capture.amountCents - (capture.refundedCents ?? 0);
        const amount = input.amountCents ?? left;
        if (!Number.isSafeInteger(amount) || amount <= 0) unprocessable(operation, "CANNOT_BE_ZERO_OR_NEGATIVE", "The refund must be at least $0.01.");
        if (amount > left) unprocessable(operation, "REFUND_AMOUNT_EXCEEDED", "The refund exceeds what is left of the capture.");
        save(db, "capture", capture.id, { ...capture, refundedCents: (capture.refundedCents ?? 0) + amount } satisfies MockCapture);
        return { id: mockId("REFUND"), status: "COMPLETED", amountCents: amount };
      });
    },

    async createInvoiceRecord(input) {
      const operation = "create invoice record";
      return tx(db, () => {
        const existing = kvGet(db, keyOf("invoice-number", input.invoiceNumber));
        if (existing) {
          const stored = load<PaypalInvoice>(db, "inv", existing);
          if (stored) return { id: stored.id, invoiceNumber: stored.invoiceNumber, status: stored.status, amountCents: stored.amountCents, url: stored.url };
        }
        if (!input.invoiceNumber || input.invoiceNumber.length > 25) unprocessable(operation, "INVALID_INVOICE_NUMBER", "Invoice numbers have 1 to 25 characters.");
        if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) unprocessable(operation, "INVALID_AMOUNT", "The amount must be at least $0.01.");
        const invoice: PaypalInvoice = {
          id: mockId("INV"),
          invoiceNumber: input.invoiceNumber,
          status: "MARKED_AS_PAID",
          amountCents: input.amountCents,
          url: null,
        };
        save(db, "inv", invoice.id, { ...invoice, recipientEmail: input.recipientEmail, itemDescription: input.itemDescription, createdAt: now() });
        kvSet(db, keyOf("invoice-number", input.invoiceNumber), invoice.id);
        return invoice;
      });
    },
  };

  function requireDispute(operation: string, disputeId: string): MockDispute {
    return load<MockDispute>(db, "dispute", disputeId) ?? notFound(operation, `dispute ${disputeId}`);
  }

  /** Age the dispute on the demo clock, refuse changes to a resolved one, apply `change`, save. */
  function changeDispute(operation: string, disputeId: string, change: (d: MockDispute, at: number) => void): void {
    tx(db, () => {
      const at = now();
      const d = aged(db, requireDispute(operation, disputeId), at);
      if (d.status === "RESOLVED") unprocessable(operation, "DISPUTE_ALREADY_RESOLVED", "The dispute is already resolved.");
      change(d, at);
      d.updatedAt = at;
      save(db, "dispute", d.id, d);
    });
  }
}

// ---------------------------------------------------------------- mock disputes

/** The mock buyer's PayPal account (shown as the payer of approved mock orders). */
export const MOCK_PAYER_EMAIL = "northwind.buyer@personal.example.com";
/** PayPal gives the seller 10 days to answer before the dispute closes in the buyer's favour. */
export const SELLER_RESPONSE_DAYS = 10;

export interface MockDispute {
  id: string;
  captureId: string;
  reason: string;
  status: string;
  stage: string;
  amountCents: number;
  outcome: string | null;
  refundedCents: number;
  messages: Array<{ postedBy: "BUYER" | "SELLER" | "ARBITER"; content: string; at: number }>;
  evidences: Array<{ type: string; notes: string; at: number }>;
  offer: { amountCents: number; note: string; at: number } | null;
  sellerResponseDueAt: number | null;
  createdAt: number;
  updatedAt: number;
}

function allMockDisputes(db: Db): MockDispute[] {
  const rows = stmt(db, "SELECT value FROM kv WHERE key LIKE ? ORDER BY key").all(`${PREFIX}dispute:%`) as Array<{ value: string }>;
  return rows.map((r) => parseJson<MockDispute | null>(r.value, null)).filter((d): d is MockDispute => d !== null);
}

function resolveDispute(db: Db, d: MockDispute, at: number, outcome: string, refundCents: number): void {
  d.status = "RESOLVED";
  d.outcome = outcome;
  d.refundedCents = refundCents;
  d.sellerResponseDueAt = null;
  d.updatedAt = at;
  if (refundCents > 0) {
    const capture = load<MockCapture>(db, "capture", d.captureId);
    if (capture) save(db, "capture", capture.id, { ...capture, refundedCents: (capture.refundedCents ?? 0) + refundCents } satisfies MockCapture);
  }
}

/** A seller who never answers loses: past the response deadline the dispute resolves in the buyer's favour. */
function aged(db: Db, d: MockDispute, at: number): MockDispute {
  if (d.status === "WAITING_FOR_SELLER_RESPONSE" && d.sellerResponseDueAt != null && at >= d.sellerResponseDueAt) {
    d.messages.push({ postedBy: "ARBITER", content: "The seller did not respond in time; the case closed in the buyer's favour.", at: d.sellerResponseDueAt });
    resolveDispute(db, d, d.sellerResponseDueAt, "RESOLVED_BUYER_FAVOUR", d.amountCents);
    save(db, "dispute", d.id, d);
  }
  return d;
}

function disputeSummary(d: MockDispute): PaypalDisputeSummary {
  return { id: d.id, status: d.status, reason: d.reason, stage: d.stage, amountCents: d.amountCents, createdAt: d.createdAt, updatedAt: d.updatedAt };
}

/** What PayPal would offer the seller as HATEOAS links in this state. */
function allowedActions(d: MockDispute): string[] {
  if (d.status === "RESOLVED") return [];
  const actions: string[] = ["accept_claim"];
  if (d.status === "WAITING_FOR_SELLER_RESPONSE") actions.push("provide_evidence");
  if (d.stage === "INQUIRY") actions.push("send_message", "make_offer", "escalate");
  if (d.status === "UNDER_REVIEW") actions.push("adjudicate", "require_evidence");
  return actions;
}

function disputeView(d: MockDispute): PaypalDispute {
  const buyer = d.messages.filter((m) => m.postedBy === "BUYER").at(-1);
  return {
    ...disputeSummary(d),
    captureIds: [d.captureId],
    outcome: d.outcome,
    refundedCents: d.status === "RESOLVED" ? d.refundedCents : null,
    buyerMessage: buyer?.content ?? null,
    sellerResponseDueAt: d.sellerResponseDueAt,
    actions: allowedActions(d),
  };
}

export interface MockDisputeInput {
  captureId: string;
  reason?: string;
  message?: string;
  amountCents?: number;
}

/**
 * The buyer opens a dispute on a capture, as PayPal's Resolution Center would (mock mode only). Defaults: the
 * whole capture, reason MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED. Throws when the capture is unknown or the
 * amount is more than what is left of it.
 */
export function openMockDispute(deps: { db: Db; clock?: Pick<Clock, "now"> }, input: MockDisputeInput): PaypalDispute {
  const { db } = deps;
  const at = deps.clock?.now() ?? Date.now();
  return tx(db, () => {
    const capture = load<MockCapture>(db, "capture", input.captureId);
    if (!capture) throw new PaypalError({ operation: "open dispute", paypalName: "RESOURCE_NOT_FOUND", message: `No mock capture ${input.captureId}.`, httpStatus: 404 });
    const refuse = (description: string): never => {
      throw new PaypalError({ operation: "open dispute", paypalName: "UNPROCESSABLE_ENTITY", message: description, issues: [{ issue: "DISPUTE_NOT_ALLOWED", description }], httpStatus: 422 });
    };
    const open = allMockDisputes(db).filter((d) => d.captureId === capture.id && d.status !== "RESOLVED");
    if (open.length > 0) refuse(`The buyer already has dispute ${open[0]?.id} open on this charge.`);
    const left = capture.amountCents - (capture.refundedCents ?? 0);
    const amount = input.amountCents ?? left;
    if (left <= 0) refuse("This charge was already refunded in full, so there is nothing left to dispute.");
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > left) refuse(`A dispute can claim 1 to ${left} cents: what is left of this charge.`);
    const d: MockDispute = {
      id: mockId("D"),
      captureId: capture.id,
      reason: input.reason ?? "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
      status: "WAITING_FOR_SELLER_RESPONSE",
      stage: "INQUIRY",
      amountCents: amount,
      outcome: null,
      refundedCents: 0,
      messages: input.message?.trim() ? [{ postedBy: "BUYER", content: input.message.trim().slice(0, 2_000), at }] : [],
      evidences: [],
      offer: null,
      sellerResponseDueAt: at + SELLER_RESPONSE_DAYS * DAY_MS,
      createdAt: at,
      updatedAt: at,
    };
    save(db, "dispute", d.id, d);
    return disputeView(d);
  });
}

/** What a mock dispute looks like inside (tests). */
export function inspectMockDispute(db: Db, disputeId: string): Readonly<MockDispute> | null {
  return load<MockDispute>(db, "dispute", disputeId);
}

function batchView(batch: MockBatch): PaypalPayoutBatch {
  return { batchId: batch.batchId, status: batch.status, items: batch.items.map((item) => ({ ...item })) };
}

/** What a mock authorization looks like inside (tests check that holds are released). */
export function inspectMockAuthorization(db: Db, authorizationId: string): Readonly<MockAuthorization> | null {
  return load<MockAuthorization>(db, "auth", authorizationId);
}
