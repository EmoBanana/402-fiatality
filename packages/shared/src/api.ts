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
  generatedAt: number;
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
