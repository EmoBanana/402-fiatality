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
    gridQuery: missing("ai.gridQuery"),
    chatProxy: missing("ai.chatProxy"),
  };
}
