/** REST DTOs shared by the gateway (producer) and the web app / agent (consumers). */
import type { Micros } from "./money";
import type { Policy } from "./policy";
import type { VoidReason, VoidRules } from "./voidRules";

export type PaypalMode = "mock" | "sandbox";

export interface HealthDTO {
  ok: boolean;
  version: string;
  paypal: { mode: PaypalMode; configured: boolean };
  llm: { provider: string; model: string; reachable: boolean; detail?: string };
  demo: boolean;
  now: number;
}

export interface ConfigDTO {
  paypalMode: PaypalMode;
  currency: "USD";
  demo: boolean;
  publicBaseUrl: string;
  llm: { provider: string; model: string };
}

export interface ApiErrorDTO {
  error: string;
  message: string;
  details?: unknown;
}

// ---------------------------------------------------------------- sellers

export type HttpMethod = "GET" | "POST";

export interface EndpointDTO {
  id: string;
  method: HttpMethod;
  /** Path on the seller's API, may contain :params, e.g. "/v1/products/:id". */
  path: string;
  priceMicros: Micros;
  description?: string | null;
  /** Optional JSON Schema the response must match to be billable. */
  responseSchema?: Record<string, unknown> | null;
}

export interface SellerStatsDTO {
  calls: number;
  voids: number;
  grossMicros: Micros;
}

export interface SellerDTO {
  id: string;
  name: string;
  baseUrl: string;
  authHeader?: string | null;
  hasApiKey: boolean;
  paypalEmail: string;
  voidRules: VoidRules;
  status: "active" | "paused";
  endpoints: EndpointDTO[];
  /** Agents call `${gatewayUrl}${endpoint.path}`. */
  gatewayUrl: string;
  balanceMicros: Micros;
  paidOutMicros: Micros;
  /** Earnings from charges under an open PayPal dispute, held back from payouts until it resolves. */
  heldMicros?: Micros;
  createdAt: number;
  stats: SellerStatsDTO;
}

export interface SellerCreateDTO {
  id: string;
  name: string;
  baseUrl: string;
  authHeader?: string;
  apiKey?: string;
  paypalEmail: string;
  voidRules?: Partial<VoidRules>;
  endpoints: Array<Omit<EndpointDTO, "id">>;
}

export interface SellerEarningsDTO {
  seller: SellerDTO;
  lines: Array<SettlementLineDTO & { settlementId: string; tabId: string; createdAt: number }>;
  payouts: Array<PayoutItemDTO & { payoutId: string; createdAt: number }>;
}

export interface CatalogEntryDTO {
  sellerId: string;
  sellerName: string;
  gatewayUrl: string;
  voidRules: VoidRules;
  endpoints: EndpointDTO[];
}

// ---------------------------------------------------------------- companies & tabs

export interface CompanyDTO {
  id: string;
  name: string;
  createdAt: number;
}

export type TabStatus =
  | "pending_approval"
  | "active"
  | "paused"
  | "frozen"
  | "closing"
  | "settled"
  | "cancelled"
  | "failed";

export interface TabTotalsDTO {
  calls: number;
  accepted: number;
  voided: number;
  billableMicros: Micros;
  voidedMicros: Micros;
  /** Hold minus billable spend (never below 0). */
  remainingMicros: Micros;
  spentTodayMicros: Micros;
}

export interface TabDTO {
  id: string;
  companyId: string;
  companyName?: string | null;
  label?: string | null;
  status: TabStatus;
  policy: Policy;
  policyText?: string | null;
  holdCents: number;
  paypal: {
    orderId?: string | null;
    authorizationId?: string | null;
    reauthorizationId?: string | null;
    approveUrl?: string | null;
  };
  authorizedAt?: number | null;
  /** End of PayPal's 3-day honor window for the current authorization. */
  honorUntil?: number | null;
  /** Authorization expiry (29 days). */
  expiresAt?: number | null;
  reauthorizedAt?: number | null;
  /** Planned reauthorization time (day 4, or day 25 for small tabs). */
  reauthorizeAt?: number | null;
  /** Planned charge time (day 7, or day 28 for small tabs). */
  closeAt?: number | null;
  closedAt?: number | null;
  carryInMicros: Micros;
  createdAt: number;
  totals: TabTotalsDTO;
}

export interface TabCreateDTO {
  companyId: string;
  label?: string;
  policy: Policy;
  policyText?: string;
}

export interface TabCreatedDTO {
  tab: TabDTO;
  /** Secret that lets an agent register its signing key on this tab. */
  enrollToken: string;
  orderId: string;
  /** Where the company approves the PayPal hold (PayPal sandbox or the mock approval page). */
  approveUrl: string;
}

export interface AgentKeyRegisterDTO {
  agentId: string;
  /** Ed25519 public key, base64url raw 32 bytes. */
  publicKey: string;
  enrollToken: string;
}

// ---------------------------------------------------------------- vouchers, alarms, reviews

export type VoucherStatus = "accepted" | "voided";

export interface VoucherDTO {
  id: string;
  tabId: string;
  sellerId: string;
  endpointId?: string | null;
  seq: number;
  priceMicros: Micros;
  cumulativeMicros: Micros;
  method: string;
  path: string;
  agentId?: string | null;
  taskId?: string | null;
  status: VoucherStatus;
  voidReason?: VoidReason | null;
  httpStatus?: number | null;
  latencyMs?: number | null;
  responseBytes?: number | null;
  reviewId?: string | null;
  settlementId?: string | null;
  createdAt: number;
}

export type AlarmKind = "repeat_request" | "error_streak" | "spend_spike" | "velocity" | "budget_threshold";

export interface AlarmDTO {
  id: string;
  tabId: string;
  kind: AlarmKind;
  message: string;
  detail: Record<string, unknown>;
  status: "open" | "reviewing" | "resolved";
  createdAt: number;
}

export type ReviewRole = "prosecutor" | "defender" | "judge";

export interface ReviewMessageDTO {
  role: ReviewRole;
  content: string;
  at: number;
}

export type ReviewVerdict = "resume" | "void" | "freeze" | "escalate";
export type ReviewFault = "seller" | "agent" | "none";

export interface ReviewDTO {
  id: string;
  tabId: string;
  alarmId?: string | null;
  status: "running" | "done" | "failed";
  verdict?: ReviewVerdict | null;
  fault?: ReviewFault | null;
  confidence?: number | null;
  reason?: string | null;
  voidedVoucherIds: string[];
  transcript: ReviewMessageDTO[];
  model?: string | null;
  decidedBy?: "ai" | "human" | null;
  createdAt: number;
  finishedAt?: number | null;
}

// ---------------------------------------------------------------- settlement & payouts

export interface SettlementLineDTO {
  sellerId: string;
  sellerName?: string | null;
  grossMicros: Micros;
  /** This seller's share of the PayPal capture fee (pro rata by gross). */
  feeShareMicros: Micros;
  netMicros: Micros;
  calls: number;
}

export interface SettlementDTO {
  id: string;
  tabId: string;
  status: "pending" | "completed" | "failed";
  billableMicros: Micros;
  chargedCents: number;
  /** Sub-cent remainder rolled into the company's next tab. */
  carryOutMicros: Micros;
  paypalFeeCents: number;
  captureId?: string | null;
  /** What per-call PayPal payments would have cost in fees. */
  naiveFeeCents: number;
  callCount: number;
  voidCount: number;
  voidedMicros: Micros;
  lines: SettlementLineDTO[];
  createdAt: number;
  error?: string | null;
}

export interface PayoutItemDTO {
  sellerId: string;
  sellerName?: string | null;
  amountCents: number;
  feeCents: number;
  paypalItemId?: string | null;
  status: string;
}

export interface PayoutDTO {
  id: string;
  paypalBatchId?: string | null;
  status: "pending" | "success" | "failed" | "partial";
  totalCents: number;
  feeCents: number;
  items: PayoutItemDTO[];
  createdAt: number;
  error?: string | null;
}

export interface StatementDTO {
  tab: TabDTO;
  company: CompanyDTO;
  settlement?: SettlementDTO | null;
  sellers: SettlementLineDTO[];
  voids: { count: number; micros: Micros; byReason: Record<string, number> };
  fees: { paypalFeeCents: number; effectiveRatePct: number; naiveFeeCents: number; savedCents: number };
  /** The PayPal invoice recorded as paid for this tab's charge (PAYPAL_INVOICE_RECORDS=1). */
  invoice?: InvoiceDTO | null;
  /** PayPal disputes opened on this tab's charge, newest first. */
  disputes?: DisputeDTO[];
  generatedAt: number;
}

// ---------------------------------------------------------------- disputes & invoices (PayPal Disputes + Invoicing APIs)

/** PayPal's dispute status (Disputes API v1). */
export type DisputeStatus = "OPEN" | "WAITING_FOR_BUYER_RESPONSE" | "WAITING_FOR_SELLER_RESPONSE" | "UNDER_REVIEW" | "RESOLVED" | "OTHER";

/** What the AI jury recommends for a dispute on a tab's charge. */
export type DisputeRecommendation = "contest" | "partial_refund" | "accept";

/**
 * The AI jury's hearing of a dispute: the prosecutor argues the buyer's claim, the defender argues the charge stands
 * on the signed IOU ledger, and the judge recommends a response for a human to send.
 */
export interface DisputeJuryDTO {
  status: "running" | "done" | "failed";
  recommendation?: DisputeRecommendation | null;
  /** Refund the judge suggests for partial_refund or accept, in cents. */
  refundCents?: number | null;
  confidence?: number | null;
  reason?: string | null;
  /** The response drafted for PayPal (evidence notes or the offer/acceptance note). */
  draft?: string | null;
  transcript: ReviewMessageDTO[];
  model?: string | null;
  createdAt: number;
  finishedAt?: number | null;
}

/** sandbox_adjudicate exists only in PayPal's sandbox (and the mock): it settles the dispute for the demo. */
export type DisputeActionKind = "send_evidence" | "make_offer" | "accept_claim" | "sandbox_adjudicate";

export interface DisputeActionDTO {
  kind: DisputeActionKind;
  at: number;
  amountCents?: number | null;
  note?: string | null;
  ok: boolean;
  error?: string | null;
}

export interface DisputeDTO {
  /** PayPal dispute id (PP-D-…), or MOCK-D-… in mock mode. */
  id: string;
  settlementId: string | null;
  tabId: string | null;
  companyId: string | null;
  /** The disputed PayPal capture (the tab's one charge). */
  captureId: string | null;
  status: DisputeStatus;
  /** PayPal's reason code, e.g. MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED or UNAUTHORISED. */
  reason: string;
  /** INQUIRY, CHARGEBACK, PRE_ARBITRATION or ARBITRATION. */
  stage: string | null;
  amountCents: number;
  /** PayPal's outcome code once resolved, e.g. RESOLVED_BUYER_FAVOUR or RESOLVED_SELLER_FAVOUR. */
  outcome: string | null;
  /** Refunded to the buyer through this dispute; deducted from the tab's sellers pro rata. */
  refundedCents: number;
  buyerMessage: string | null;
  sellerResponseDueAt: number | null;
  /** Seller earnings from the disputed charge held back from payouts while the dispute is open. */
  heldMicros: Micros;
  jury: DisputeJuryDTO | null;
  actions: DisputeActionDTO[];
  createdAt: number;
  updatedAt: number;
}

export interface DisputeSyncResultDTO {
  checked: number;
  created: number;
  updated: number;
}

export interface DisputeActionRequestDTO {
  kind: Exclude<DisputeActionKind, "sandbox_adjudicate">;
  note?: string;
  /** make_offer: the refund offered; accept_claim: a partial refund (omit for the full amount). */
  amountCents?: number;
}

/** Sandbox and mock only: settle a dispute for the demo. */
export interface DisputeAdjudicateDTO {
  outcome: "buyer" | "seller";
}

/** Mock mode only: simulate the buyer opening a dispute on a settled tab's charge. */
export interface MockDisputeCreateDTO {
  settlementId: string;
  reason?: string;
  message?: string;
  amountCents?: number;
}

export interface InvoiceDTO {
  /** PayPal invoice id (INV2-…), or MOCK-INV-… in mock mode. */
  id: string;
  settlementId: string;
  invoiceNumber: string;
  /** PayPal's invoice status, e.g. PAID or MARKED_AS_PAID. */
  status: string;
  amountCents: number;
  /** PayPal's payer view of the invoice, when PayPal returns one. */
  url: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------- agent runs & purchases

export type AgentMode = "llm" | "scripted" | "runaway";

export interface AgentRunCreateDTO {
  tabId: string;
  task: string;
  mode: AgentMode;
  maxSteps?: number;
}

export type AgentStepKind =
  | "thought"
  | "paid_call"
  | "decision"
  | "purchase_proposal"
  | "paused"
  | "error"
  | "finished";

export interface AgentStepDTO {
  runId: string;
  index: number;
  kind: AgentStepKind;
  text: string;
  at: number;
  costMicros?: Micros;
  cumulativeMicros?: Micros;
  sellerId?: string;
  endpoint?: string;
  status?: VoucherStatus;
  voidReason?: string;
  data?: unknown;
}

export interface AgentRunDTO {
  id: string;
  tabId: string;
  agentId: string;
  task: string;
  mode: AgentMode;
  status: "running" | "finished" | "stopped" | "failed";
  steps: AgentStepDTO[];
  spentMicros: Micros;
  createdAt: number;
  finishedAt?: number | null;
  result?: { summary: string; purchaseId?: string | null } | null;
  error?: string | null;
}

export interface PurchaseProposalDTO {
  tabId: string;
  title: string;
  amountCents: number;
  merchant?: string;
  productUrl?: string;
  imageUrl?: string;
  researchCostMicros: Micros;
  reasoning?: string;
}

export interface PurchaseDTO {
  id: string;
  tabId?: string | null;
  title: string;
  amountCents: number;
  merchant?: string | null;
  productUrl?: string | null;
  imageUrl?: string | null;
  paypalOrderId?: string | null;
  approveUrl?: string | null;
  status: "proposed" | "awaiting_approval" | "captured" | "cancelled" | "failed";
  researchCostMicros: Micros;
  reasoning?: string | null;
  createdAt: number;
}

// ---------------------------------------------------------------- metrics, clock, AI

export interface MetricsSummaryDTO {
  calls: number;
  accepted: number;
  voided: number;
  billableMicros: Micros;
  voidedMicros: Micros;
  settledMicros: Micros;
  paypalFeeCents: number;
  /** Fees if every call had been its own PayPal payment. */
  naiveFeeCents: number;
  sellersPaidMicros: Micros;
  activeTabs: number;
  openAlarms: number;
  reviews: number;
}

export interface TimeseriesPointDTO {
  /** Bucket start, epoch ms. */
  t: number;
  calls: number;
  voids: number;
  spendMicros: Micros;
  bySeller: Record<string, Micros>;
}

export interface ClockDTO {
  now: number;
  offsetMs: number;
}

export interface PolicyParseRequestDTO {
  text: string;
}

export interface PolicyParseDTO {
  policy: Policy;
  /** Plain-language bullet points describing the parsed limits. */
  summary: string[];
  model: string;
  usedFallback?: boolean;
}

export interface GridQueryRequestDTO {
  question: string;
  /** From gridApi.getStructuredSchema() (AG Grid AI Toolkit). */
  schema: Record<string, unknown>;
  /** From gridApi.getState(). */
  state: Record<string, unknown>;
}

export interface GridQueryResponseDTO {
  state: Record<string, unknown>;
  propertiesToIgnore?: string[];
  explanation: string;
  model: string;
}

// ---------------------------------------------------------------- route payloads

/** `{ ok: true }` acknowledgement (e.g. POST /api/tabs/:id/keys). */
export interface OkDTO {
  ok: true;
}

export interface CompanyCreateDTO {
  name: string;
}

/** PATCH /api/sellers/:id */
export interface SellerUpdateDTO {
  status?: "active" | "paused";
  endpoints?: Array<{ id: string; priceMicros: Micros }>;
}

/** Payment channel state for one (tab, seller) pair. */
export interface ChannelDTO {
  sellerId: string;
  lastSeq: number;
  lastCumulativeMicros: Micros;
}

/** GET /api/tabs/:id */
export interface TabDetailDTO extends TabDTO {
  channels: ChannelDTO[];
  alarms: AlarmDTO[];
  reviews: ReviewDTO[];
  settlements: SettlementDTO[];
}

/** PATCH /api/tabs/:id/schedule (demo only, Bryntum drag-to-reschedule). Epoch ms. */
export interface TabScheduleDTO {
  closeAt?: number;
  reauthorizeAt?: number;
}

/** GET /api/vouchers query string. */
export interface VoucherQueryDTO {
  tabId?: string;
  sellerId?: string;
  status?: VoucherStatus;
  /** 1..1000, default 200. */
  limit?: number;
  /** Only vouchers created before this epoch ms (pagination). */
  before?: number;
}

/** POST /api/reviews/:id/decide: a human settles an escalated review. */
export interface ReviewDecisionDTO {
  verdict: Exclude<ReviewVerdict, "escalate">;
  /** For "void": which vouchers to void. Defaults to the AI's suggestion. */
  voidVoucherIds?: string[];
  reason?: string;
}

/** POST /api/payouts/run */
export interface PayoutRunDTO {
  /** Minimum balance to pay out. Default 1000 ($10); the demo UI may go lower. */
  thresholdCents?: number;
}

export interface PayoutRunResultDTO {
  /** Null when no seller was over the threshold. */
  payout: PayoutDTO | null;
  message: string;
}

/** POST /api/purchases/:id/checkout */
export interface PurchaseCheckoutDTO {
  purchase: PurchaseDTO;
  approveUrl: string;
}

/** POST /api/clock/advance (DEMO_MODE only). */
export interface ClockAdvanceDTO {
  ms: number;
}

/**
 * postMessage from the gateway's /paypal/return and /paypal/cancel pages to the window that opened the
 * PayPal popup. A fast path only: PayPal's pages may sever `window.opener`, so the console also waits for
 * the `tab.updated` / `purchase.updated` event.
 */
export interface PaypalReturnMessage {
  type: "p402:paypal-return";
  kind: "tab" | "purchase";
  /** Tab id or purchase id. */
  ref: string;
  status: "approved" | "cancelled" | "failed";
  message?: string;
}

// ---------------------------------------------------------------- POST /api/ai/chat (OpenAI chat.completions subset)

export interface ChatToolCallDTO {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatToolDTO {
  type: "function";
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

export interface ChatMessageDTO {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: ChatToolCallDTO[];
  tool_call_id?: string;
}

/** Non-streaming only: `stream: true` is answered with one JSON body. */
export interface ChatRequestDTO {
  messages: ChatMessageDTO[];
  tools?: ChatToolDTO[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } };
  temperature?: number;
  max_tokens?: number;
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; schema: Record<string, unknown>; strict?: boolean } };
  stream?: boolean;
}

export interface ChatResponseDTO {
  id: string;
  object: "chat.completion";
  /** Unix seconds. */
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string | null; tool_calls?: ChatToolCallDTO[] };
    finish_reason: "stop" | "length" | "tool_calls" | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}
