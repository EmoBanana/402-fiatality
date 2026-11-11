/**
 * AppContext (dependency injection) and the contracts between the 402 Fiatality packages.
 *
 * Implementations (SPEC §2):
 *   PaypalClient, SettlementService -> packages/gateway/src/paypal/**, src/settlement/**   (paypal-builder)
 *   AiService, LlmClient            -> @p402/ai      exports createLlm(config.llm), createAiService(config.llm)
 *   RunAgent                        -> @p402/agent   exports runAgent
 *   DemoSellersFn, StartSellers     -> @p402/sellers exports demoSellers, startSellers
 * Gateway core reaches all of them only through `ctx`, so tests swap in fakes. `src/services.ts` picks the
 * real implementations. Other packages import these types only:
 *   import type { AiService } from "@p402/gateway/context";
 */
import type {
  AgentMode,
  AgentStepDTO,
  AlarmDTO,
  CatalogEntryDTO,
  ChatRequestDTO,
  ChatResponseDTO,
  DisputeRecommendation,
  GridQueryRequestDTO,
  GridQueryResponseDTO,
  Micros,
  PaypalMode,
  PayoutDTO,
  PolicyParseDTO,
  PurchaseCheckoutDTO,
  PurchaseDTO,
  PurchaseProposalDTO,
  ReviewFault,
  ReviewMessageDTO,
  ReviewVerdict,
  SellerCreateDTO,
  SettlementDTO,
  StatementDTO,
  TabCreateDTO,
  TabCreatedDTO,
  TabDTO,
  VoucherDTO,
} from "@p402/shared";
import type { FastifyPluginAsync } from "fastify";
import pino, { type Logger } from "pino";
import type { z } from "zod";
import { type Clock, createClock } from "./clock";
import { type AppConfig, type LlmConfig, type LlmProvider, testConfig } from "./config";
import { type Db, openDb } from "./db/db";
import { createEventBus, type EventBus } from "./events/bus";

export type { AppConfig, LlmConfig, LlmProvider, PaypalConfig, SellerEmails } from "./config";
export type { Clock } from "./clock";
export type { Db } from "./db/db";
export type { EventBus } from "./events/bus";
export type { Logger } from "pino";

/**
 * An error rendered as ApiErrorDTO `{ error: code, message, details }` with HTTP `status`. Services throw
 * these; the server's error handler maps them (and zod errors -> 400 `invalid_request`).
 */
export class AppError extends Error {
  override name = "AppError";
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Route modules export one of these; buildServer registers each with `app.register(plugin, { ctx })`. */
export type RoutePlugin = FastifyPluginAsync<{ ctx: AppContext }>;

// ===================================================================== PayPal (paypal-builder)

export interface PaypalOrder {
  id: string;
  /** CREATED | PAYER_ACTION_REQUIRED | APPROVED | COMPLETED | VOIDED ... */
  status: string;
  /** Where the payer approves (link rel "payer-action" or "approve"); null once approved. */
  approveUrl: string | null;
  /** The payer's PayPal email once known (payment_source.paypal.email_address, or the deprecated payer). */
  payerEmail?: string | null;
}

export interface PaypalAuthorization {
  id: string;
  /** CREATED | CAPTURED | PARTIALLY_CAPTURED | VOIDED | EXPIRED | DENIED | PENDING */
  status: string;
  amountCents: number;
  /** PayPal expiration_time (29 days after the original authorization), epoch ms. */
  expiresAt: number | null;
}

export interface PaypalCapture {
  id: string;
  /** COMPLETED | PENDING | DECLINED ... */
  status: string;
  amountCents: number;
  /** seller_receivable_breakdown.paypal_fee; null when PayPal did not report it. */
  feeCents: number | null;
  finalCapture: boolean;
}

export interface PaypalPayoutItemInput {
  /** Our id for the item, e.g. `${payoutId}:${sellerId}`. */
  senderItemId: string;
  receiverEmail: string;
  amountCents: number;
  note: string;
}

export interface PaypalPayoutItem {
  senderItemId: string;
  payoutItemId: string | null;
  /** transaction_status: SUCCESS | PENDING | UNCLAIMED | FAILED ... */
  status: string;
  amountCents: number;
  feeCents: number | null;
}

export interface PaypalPayoutBatch {
  batchId: string;
  /** batch_status: PENDING | PROCESSING | SUCCESS | DENIED ... */
  status: string;
  items: PaypalPayoutItem[];
}

/** A dispute as Disputes v1 lists it (GET /v1/customer/disputes). Times are epoch ms (PayPal's real time). */
export interface PaypalDisputeSummary {
  /** dispute_id, e.g. PP-D-27803 (MOCK-D-... in mock mode). */
  id: string;
  /** OPEN | WAITING_FOR_BUYER_RESPONSE | WAITING_FOR_SELLER_RESPONSE | UNDER_REVIEW | RESOLVED | OTHER */
  status: string;
  /** dispute reason, e.g. MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED or UNAUTHORISED. */
  reason: string;
  /** dispute_life_cycle_stage: INQUIRY | CHARGEBACK | PRE_ARBITRATION | ARBITRATION. */
  stage: string | null;
  /** dispute_amount in cents. */
  amountCents: number;
  createdAt: number | null;
  updatedAt: number | null;
}

/** GET /v1/customer/disputes/{id}, reduced to what 402 Fiatality uses. */
export interface PaypalDispute extends PaypalDisputeSummary {
  /** disputed_transactions[].seller_transaction_id: the disputed capture ids (our tab charges). */
  captureIds: string[];
  /** dispute_outcome.outcome_code once resolved, e.g. RESOLVED_BUYER_FAVOUR. */
  outcome: string | null;
  /**
   * Money PayPal reports as given back to the buyer: dispute_outcome.amount_refunded, else the seller's
   * DISPUTE_SETTLEMENT debits in money_movements, else refund_details.transactions. Null when PayPal reports none.
   */
  refundedCents: number | null;
  /** The buyer's latest message (untrusted text). */
  buyerMessage: string | null;
  sellerResponseDueAt: number | null;
  /**
   * What PayPal lets the seller do now, from the HATEOAS links, normalized to snake_case:
   * provide_evidence, send_message, make_offer, accept_claim, escalate, adjudicate, require_evidence, ...
   */
  actions: string[];
}

export type PaypalAdjudication = "BUYER_FAVOR" | "SELLER_FAVOR";

/** Payments v2 refund of a capture. */
export interface PaypalRefund {
  id: string;
  /** CANCELLED | FAILED | PENDING | COMPLETED */
  status: string;
  amountCents: number;
}

/** Invoicing v2: a paid invoice recorded for one tab charge (draft -> sent as a share link -> payment recorded). */
export interface PaypalInvoiceInput {
  /** detail.invoice_number, at most 25 characters (FIAT-<settlementId>). */
  invoiceNumber: string;
  /** detail.reference (the tab id). */
  reference: string;
  /** primary_recipients[0].billing_info.email_address; omitted when unknown. */
  recipientEmail: string | null;
  itemName: string;
  /** Per-seller gross and calls, and the capture id (≤ 1000 characters). */
  itemDescription: string;
  amountCents: number;
  /** detail.note to the recipient. */
  note: string;
  /** detail.memo, private to the merchant. */
  memo: string;
  /** Note on the recorded payment (names the capture). */
  paymentNote: string;
  /** PayPal-Request-Id for the draft. */
  requestId: string;
}

export interface PaypalInvoice {
  /** INV2-... (MOCK-INV-... in mock mode). */
  id: string;
  invoiceNumber: string;
  /** DRAFT | SENT | UNPAID | PAID | MARKED_AS_PAID ... */
  status: string;
  amountCents: number;
  /** detail.metadata.recipient_view_url or the payer-view link from send. */
  url: string | null;
}

/**
 * Amounts are whole cents (format with `centsToValue`). Every money-moving call takes a `requestId` sent as
 * `PayPal-Request-Id`; derive it from our ids (e.g. `capture-${settlementId}`) so retries are idempotent.
 * Failures throw an AppError subclass with PayPal's `name` and `debug_id` in `details`.
 */
export interface PaypalClient {
  readonly mode: PaypalMode;
  /** Orders v2 create, intent AUTHORIZE: the tab hold (SPEC §6.2). */
  createAuthorizeOrder(input: {
    referenceId: string;
    amountCents: number;
    description: string;
    softDescriptor: string;
    brandName: string;
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<PaypalOrder>;
  /** Orders v2 create, intent CAPTURE: an agent's retail purchase, approved by a human (SPEC §6.6). */
  createCaptureOrder(input: {
    referenceId: string;
    amountCents: number;
    itemName: string;
    description: string;
    brandName: string;
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<PaypalOrder>;
  getOrder(orderId: string): Promise<PaypalOrder>;
  /** Authorize an approved AUTHORIZE order. */
  authorizeOrder(orderId: string, requestId: string): Promise<PaypalAuthorization>;
  /** Capture an approved CAPTURE order. */
  captureOrder(orderId: string, requestId: string): Promise<PaypalCapture>;
  getAuthorization(authorizationId: string): Promise<PaypalAuthorization>;
  /** Reauthorize (allowed once, days 4-29). Returns the new authorization. */
  reauthorize(authorizationId: string, amountCents: number, requestId: string): Promise<PaypalAuthorization>;
  captureAuthorization(
    authorizationId: string,
    input: { amountCents: number; finalCapture: boolean; invoiceId: string; noteToPayer: string; requestId: string },
  ): Promise<PaypalCapture>;
  voidAuthorization(authorizationId: string, requestId: string): Promise<void>;
  /** Payouts v1 over REST (not in the Server SDK). `senderBatchId` doubles as the idempotency key. */
  createPayoutBatch(input: {
    senderBatchId: string;
    emailSubject: string;
    note: string;
    items: PaypalPayoutItemInput[];
  }): Promise<PaypalPayoutBatch>;
  getPayoutBatch(batchId: string): Promise<PaypalPayoutBatch>;

  // ---- Disputes v1 (REST). Times are PayPal's real time, epoch ms.
  /** Disputes updated after `updatedAfter` (all of the last 180 days when omitted), newest first, all pages. */
  listDisputes(input?: { updatedAfter?: number | null; disputedTransactionId?: string | null }): Promise<PaypalDisputeSummary[]>;
  getDispute(disputeId: string): Promise<PaypalDispute>;
  /** multipart/form-data with an `input` JSON part: { evidences: [{ evidence_type, notes, evidence_info? }] }. */
  provideDisputeEvidence(disputeId: string, input: { notes: string; evidenceType?: string; refundIds?: string[] }): Promise<void>;
  /** Only while the dispute is an INQUIRY. */
  sendDisputeMessage(disputeId: string, message: string): Promise<void>;
  /** offer_type REFUND for `amountCents`; only while the dispute is an INQUIRY. */
  makeDisputeOffer(disputeId: string, input: { amountCents: number; note: string; invoiceId?: string | null }): Promise<void>;
  /** accept_claim_type REFUND, or PARTIAL_REFUND with refund_amount when `refundCents` is below the disputed amount. */
  acceptDisputeClaim(disputeId: string, input: { note: string; refundCents?: number | null; invoiceId?: string | null }): Promise<void>;
  /** Escalate an INQUIRY to a PayPal claim. */
  escalateDispute(disputeId: string, note: string): Promise<void>;
  /** Sandbox-only "settle dispute" (the mock too): adjudication_outcome BUYER_FAVOR | SELLER_FAVOR. */
  adjudicateDispute(disputeId: string, outcome: PaypalAdjudication): Promise<void>;
  /** Sandbox-only "update dispute status": UNDER_REVIEW -> waiting for buyer or seller evidence. */
  requireDisputeEvidence(disputeId: string, action: "BUYER_EVIDENCE" | "SELLER_EVIDENCE"): Promise<void>;

  // ---- Payments v2
  /** Refund a capture (all of it when amountCents is omitted). */
  refundCapture(
    captureId: string,
    input: { amountCents?: number | null; invoiceId: string; noteToPayer: string; requestId: string },
  ): Promise<PaypalRefund>;

  // ---- Invoicing v2 (REST)
  /**
   * Record a charge as a paid invoice: create the draft, send it as a share link (send_to_recipient false),
   * record the payment. Resumes an earlier attempt with the same invoice number instead of failing.
   */
  createInvoiceRecord(input: PaypalInvoiceInput): Promise<PaypalInvoice>;
}

// ===================================================================== Settlement (paypal-builder)

export type CloseReason = "manual" | "threshold" | "scheduled" | "expiring";

/**
 * The tab's life with PayPal (SPEC §6): hold -> authorize -> reauthorize -> one capture -> payouts.
 * Every tab change emits `tab.updated` (rendered with getTabDTO from db/dto.ts) plus the specific event.
 * The settlement routes (src/routes/settlement.ts) and the scheduler call this; gateway core calls
 * createHold (POST /api/tabs), tick (after POST /api/clock/advance) and start/stop (src/index.ts).
 */
export interface SettlementService {
  /**
   * POST /api/tabs, input already validated with the policy normalized. Inserts the tab as pending_approval
   * with a fresh enroll token (stored as lowercase hex SHA-256 in enroll_token_hash), moves the company's
   * carried sub-cent remainder into carry_in_micros, creates the AUTHORIZE order and stores its id and URL.
   */
  createHold(input: TabCreateDTO): Promise<TabCreatedDTO>;
  /** One PayPal capture for everything billable (SPEC §6.4). Idempotent: a settled tab returns its settlement. */
  closeTab(tabId: string, reason: CloseReason): Promise<SettlementDTO>;
  /** Scheduler step (SPEC §6.3): reauthorize and close whatever is due at ctx.clock.now(). */
  tick(): Promise<void>;
  /** SPEC §6.5. Null when no seller is over the threshold (default 1000 cents). */
  runPayouts(opts?: { thresholdCents?: number }): Promise<PayoutDTO | null>;
  /** POST /api/purchases (from the agent). */
  proposePurchase(input: PurchaseProposalDTO): Promise<PurchaseDTO>;
  /** POST /api/purchases/:id/checkout: create the CAPTURE order a human approves. */
  checkoutPurchase(purchaseId: string): Promise<PurchaseCheckoutDTO>;
  /** GET /api/tabs/:id/statement */
  statement(tabId: string): Promise<StatementDTO>;
  /** Run tick() every 30 s until stop(). */
  start(): void;
  stop(): void;
}

// ===================================================================== AI (ai-builder, @p402/ai)

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmHealth {
  reachable: boolean;
  model: string;
  /** Why not reachable, e.g. "model gemma4:12b is not pulled". */
  detail?: string;
}

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  chat(messages: LlmMessage[], opts?: LlmCallOptions): Promise<string>;
  /** Structured output: the schema is sent as JSON Schema, the reply validated, one retry with the error. */
  json<T>(messages: LlmMessage[], schema: z.ZodType<T>, opts?: LlmCallOptions): Promise<T>;
  health(): Promise<LlmHealth>;
}

/** A voucher as review evidence. The excerpts are untrusted seller/agent text. */
export interface SpendReviewVoucher extends VoucherDTO {
  requestExcerpt: string | null;
  responseExcerpt: string | null;
}

export interface SpendReviewInput {
  reviewId: string;
  tab: TabDTO;
  alarm: AlarmDTO;
  /** The agent's task, when known. */
  task: string | null;
  /** Up to the 25 most recent vouchers, oldest first. */
  vouchers: SpendReviewVoucher[];
}

export interface SpendReviewResult {
  /** "escalate" when confidence < 0.6, on error, or after the 45 s budget. */
  verdict: ReviewVerdict;
  fault: ReviewFault;
  confidence: number;
  reason: string;
  /** For "void": ids from input.vouchers judged faulty (seller fault). */
  voidVoucherIds: string[];
  transcript: ReviewMessageDTO[];
  model: string;
}

/** One seller's part of the disputed charge. */
export interface DisputeReviewSeller {
  sellerId: string;
  sellerName: string | null;
  calls: number;
  grossMicros: Micros;
}

/**
 * Everything the dispute jury hears. All fields are trusted facts computed from the gateway's ledger, except
 * `buyerMessage`, which is the buyer's own text from PayPal (untrusted: fenced as evidence, never instructions).
 */
export interface DisputeReviewInput {
  disputeId: string;
  /** PayPal's reason code, e.g. UNAUTHORISED or MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED. */
  reason: string;
  status: string;
  stage: string | null;
  /** The disputed amount. */
  amountCents: number;
  buyerMessage: string | null;
  companyName: string | null;
  tab: {
    id: string;
    holdCents: number;
    /** Judged calls (accepted + voided). */
    calls: number;
    voided: number;
    voidedMicros: Micros;
    authorizedAt: number | null;
    closedAt: number | null;
  };
  settlement: {
    id: string;
    captureId: string | null;
    chargedCents: number;
    /** Billed (accepted) calls in this charge. */
    callCount: number;
    paypalFeeCents: number;
  };
  sellers: DisputeReviewSeller[];
  /** The tab's voided calls by void reason (never billed). */
  voidsByReason: Record<string, number>;
  /** Every billed call carries an Ed25519-signed IOU; the gateway re-verifies them against the tab's enrolled keys. */
  signatures: {
    billedCalls: number;
    /** Billed calls whose signature verifies with a key enrolled on this company's own tab. */
    verified: number;
    /** Agent keys enrolled on the tab (by the company's enroll token). */
    enrolledKeys: number;
    agentIds: string[];
    samples: Array<{ voucherId: string; requestHash: string; agentId: string | null }>;
  };
  /** The tab's AI spend reviews and their verdicts, oldest first. */
  reviews: Array<{ alarmKind: string | null; verdict: string | null; fault: string | null; reason: string | null; decidedBy: string | null }>;
  /** Billed calls that repeated an earlier identical request (same seller and request hash) on this charge. */
  repeats: { calls: number; micros: Micros; sellerId: string | null; label: string | null };
  /** A spend review froze the tab (the company's own agent ran away). */
  frozenByReview: boolean;
}

export interface DisputeReviewResult {
  recommendation: DisputeRecommendation;
  /** contest: 0; partial_refund: 1 .. amount - 1; accept: the refund (usually the full disputed amount). */
  refundCents: number;
  confidence: number;
  /** One sentence. */
  reason: string;
  /** The response drafted for PayPal: evidence notes (contest) or the offer/acceptance note. */
  draft: string;
  transcript: ReviewMessageDTO[];
  model: string;
  /** The model failed or ran out of time; the recommendation comes from the ledger rules. */
  failed?: boolean;
  /** Why it failed, when it did. */
  error?: string | null;
}

export interface AiService {
  readonly llm: LlmClient;
  /** Plain-English budget -> Policy (SPEC §7). Falls back to the regex parser when the model is down. */
  parsePolicy(text: string, catalog: CatalogEntryDTO[]): Promise<PolicyParseDTO>;
  /** Prosecutor -> defender -> judge. `onMessage` fires as each role finishes. Never throws: failures escalate. */
  reviewSpend(
    input: SpendReviewInput,
    onMessage: (message: ReviewMessageDTO) => void,
    signal?: AbortSignal,
  ): Promise<SpendReviewResult>;
  /**
   * The dispute jury: prosecutor (the buyer's claim) -> defender (the charge stands on the signed ledger) -> judge.
   * `onMessage` fires as each role finishes. Never throws: a model failure or the review budget ends in
   * `failed: true` with the ledger rules' recommendation as a fallback.
   */
  reviewDispute(
    input: DisputeReviewInput,
    onMessage: (message: ReviewMessageDTO) => void,
    signal?: AbortSignal,
  ): Promise<DisputeReviewResult>;
  /** AG Grid AI Toolkit: question + schema + state -> new grid state. */
  gridQuery(request: GridQueryRequestDTO): Promise<GridQueryResponseDTO>;
  /** POST /api/ai/chat for the AG Studio adapter (non-streaming). */
  chatProxy(request: ChatRequestDTO, signal?: AbortSignal): Promise<ChatResponseDTO>;
}

// ===================================================================== Agent (buyer-agent-builder, @p402/agent)

export interface AgentRunOptions {
  runId: string;
  /** Gateway origin, e.g. http://localhost:4020: paywall at /s/:sellerId/*, API at /api/*. */
  gatewayUrl: string;
  tabId: string;
  agentId: string;
  /** Ed25519 private key as JWK JSON (generateAgentKeyPair); its public key is already registered on the tab. */
  privateKey: string;
  task: string;
  mode: AgentMode;
  /** Required for mode "llm". */
  llm?: LlmClient;
  maxSteps?: number;
  /** Cost attribution written into every voucher (`voucher.task`). */
  taskId?: string;
  /** Extra headers for /api calls (x-p402-admin when DEMO_MODE=0). Never sent to sellers. */
  apiHeaders?: Record<string, string>;
  signal?: AbortSignal;
  onStep: (step: AgentStepDTO) => void;
}

export interface AgentRunResult {
  status: "finished" | "stopped" | "failed";
  summary: string;
  spentMicros: Micros;
  purchaseId?: string | null;
  error?: string | null;
}

export type RunAgent = (opts: AgentRunOptions) => Promise<AgentRunResult>;

// ===================================================================== Demo sellers (buyer-agent-builder, @p402/sellers)

/** AppConfig satisfies this, so the seeder calls `ctx.demoSellers(ctx.config)`. */
export type DemoSellersConfig = Pick<AppConfig, "sellersBaseUrl" | "channel3ApiKey" | "sellerEmails">;

export type DemoSellersFn = (config: DemoSellersConfig) => SellerCreateDTO[];

export interface StartSellersOptions {
  /** 0 picks a free port (tests). */
  port: number;
  host?: string;
  /** Share of flaky reviews responses, 0..1. */
  flakyRate?: number;
  /** Seed for deterministic flakiness in tests. */
  seed?: number;
}

export interface RunningSellers {
  url: string;
  close(): Promise<void>;
}

export type StartSellers = (opts: StartSellersOptions) => Promise<RunningSellers>;

// ===================================================================== AppContext

export interface AppContext {
  config: AppConfig;
  db: Db;
  bus: EventBus;
  clock: Clock;
  log: Logger;
  paypal: PaypalClient;
  settlement: SettlementService;
  ai: AiService;
  runAgent: RunAgent;
  demoSellers: DemoSellersFn;
}

/** A service, or a factory that receives the context being built (paypal, then ai, then settlement). */
export type ServiceFactory<T> = T | ((ctx: AppContext) => T);

export interface ContextOverrides {
  db?: Db;
  log?: Logger;
  /** Real-time source under the clock (tests pass a fake). */
  realNow?: () => number;
  paypal?: ServiceFactory<PaypalClient>;
  ai?: ServiceFactory<AiService>;
  settlement?: ServiceFactory<SettlementService>;
  runAgent?: RunAgent;
  demoSellers?: DemoSellersFn;
}

/** Build the context. Services not overridden are stubs that throw AppError 503 `not_wired`. */
export function createContext(config: AppConfig, overrides: ContextOverrides = {}): AppContext {
  const db = overrides.db ?? openDb(config.dbPath);
  const log = overrides.log ?? createLogger(config);
  const clock = createClock(db, { demo: config.demo, realNow: overrides.realNow });
  const ctx: AppContext = {
    config,
    db,
    bus: createEventBus({ db, clock, log }),
    clock,
    log,
    paypal: stubPaypal(config.paypal.mode),
    settlement: stubSettlement(),
    ai: stubAi(config.llm),
    runAgent: overrides.runAgent ?? (async () => notWired("runAgent")),
    demoSellers: overrides.demoSellers ?? (() => []),
  };
  if (overrides.paypal) ctx.paypal = resolve(overrides.paypal, ctx);
  if (overrides.ai) ctx.ai = resolve(overrides.ai, ctx);
  if (overrides.settlement) ctx.settlement = resolve(overrides.settlement, ctx);
  return ctx;
}

/** Offline context for tests: in-memory SQLite, mock modes, silent logs, demo on. */
export function createTestContext(overrides: ContextOverrides & { config?: Partial<AppConfig> } = {}): AppContext {
  const { config, ...rest } = overrides;
  return createContext(testConfig(config), { log: pino({ level: "silent" }), ...rest });
}

const SECRET_KEYS = ["authorization", "apiKey", "clientSecret", "privateKey", "enrollToken", "accessToken"];

/** pino's `*.key` only matches one level down, so list top-level keys too. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-api-key"]',
  'req.headers["x-p402-admin"]',
  'req.headers["payment-signature"]',
  ...SECRET_KEYS,
  ...SECRET_KEYS.map((key) => `*.${key}`),
];

export function createLogger(config: Pick<AppConfig, "logLevel" | "nodeEnv">): Logger {
  const pretty = config.nodeEnv !== "test" && config.logLevel !== "silent";
  return pino({
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" } } }
      : {}),
  });
}

function resolve<T extends object>(service: ServiceFactory<T>, ctx: AppContext): T {
  return typeof service === "function" ? (service as (ctx: AppContext) => T)(ctx) : service;
}

function notWired(what: string): never {
  throw new AppError(503, "not_wired", `${what} is not wired yet (see src/services.ts)`);
}

const missing =
  (what: string) =>
  async (): Promise<never> =>
    notWired(what);

function stubPaypal(mode: PaypalMode): PaypalClient {
  return {
    mode,
    createAuthorizeOrder: missing("paypal.createAuthorizeOrder"),
    createCaptureOrder: missing("paypal.createCaptureOrder"),
    getOrder: missing("paypal.getOrder"),
    authorizeOrder: missing("paypal.authorizeOrder"),
    captureOrder: missing("paypal.captureOrder"),
    getAuthorization: missing("paypal.getAuthorization"),
    reauthorize: missing("paypal.reauthorize"),
    captureAuthorization: missing("paypal.captureAuthorization"),
    voidAuthorization: missing("paypal.voidAuthorization"),
    createPayoutBatch: missing("paypal.createPayoutBatch"),
    getPayoutBatch: missing("paypal.getPayoutBatch"),
    listDisputes: missing("paypal.listDisputes"),
    getDispute: missing("paypal.getDispute"),
    provideDisputeEvidence: missing("paypal.provideDisputeEvidence"),
    sendDisputeMessage: missing("paypal.sendDisputeMessage"),
    makeDisputeOffer: missing("paypal.makeDisputeOffer"),
    acceptDisputeClaim: missing("paypal.acceptDisputeClaim"),
    escalateDispute: missing("paypal.escalateDispute"),
    adjudicateDispute: missing("paypal.adjudicateDispute"),
    requireDisputeEvidence: missing("paypal.requireDisputeEvidence"),
    refundCapture: missing("paypal.refundCapture"),
    createInvoiceRecord: missing("paypal.createInvoiceRecord"),
  };
}

function stubSettlement(): SettlementService {
  return {
    createHold: missing("settlement.createHold"),
    closeTab: missing("settlement.closeTab"),
    tick: async () => {},
    runPayouts: missing("settlement.runPayouts"),
    proposePurchase: missing("settlement.proposePurchase"),
    checkoutPurchase: missing("settlement.checkoutPurchase"),
    statement: missing("settlement.statement"),
    start: () => {},
    stop: () => {},
  };
}

function stubAi(llm: LlmConfig): AiService {
  return {
    llm: {
      provider: llm.provider,
      model: llm.model,
      chat: missing("ai.llm.chat"),
      json: missing("ai.llm.json"),
      health: async () => ({ reachable: false, model: llm.model, detail: "AI service is not wired yet" }),
    },
    parsePolicy: missing("ai.parsePolicy"),
    reviewSpend: missing("ai.reviewSpend"),
    reviewDispute: missing("ai.reviewDispute"),
    gridQuery: missing("ai.gridQuery"),
    chatProxy: missing("ai.chatProxy"),
  };
}
