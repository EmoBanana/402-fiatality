/**
 * Row types for schema.sql and the row -> DTO mappers. Every route and event renders a DTO through these,
 * so the gateway core and the settlement code always produce identical shapes.
 * Queries that expose vouchers must exclude status 'pending' (in-flight) rows.
 */
import {
  DEFAULT_POLICY,
  DEFAULT_VOID_RULES,
  MICROS_PER_CENT,
  type AgentMode,
  type AgentRunDTO,
  type AgentStepDTO,
  type AgentStepKind,
  type AlarmDTO,
  type AlarmKind,
  type CatalogEntryDTO,
  type ChannelDTO,
  type CompanyDTO,
  type EndpointDTO,
  type HttpMethod,
  type PayoutDTO,
  type PayoutItemDTO,
  type Policy,
  type PurchaseDTO,
  type ReviewDTO,
  type ReviewFault,
  type ReviewMessageDTO,
  type ReviewVerdict,
  type SellerDTO,
  type SettlementDTO,
  type SettlementLineDTO,
  type TabDTO,
  type TabStatus,
  type TabTotalsDTO,
  type VoidReason,
  type VoidRules,
  type VoucherDTO,
  type VoucherStatus,
} from "@p402/shared";
import { startOfUtcDay } from "../clock";
import { type Db, parseJson, stmt } from "./db";

// ---------------------------------------------------------------- rows

export interface CompanyRow {
  id: string;
  name: string;
  created_at: number;
}

export interface SellerRow {
  id: string;
  name: string;
  base_url: string;
  auth_header: string | null;
  api_key_enc: string | null;
  paypal_email: string;
  void_rules: string;
  status: "active" | "paused";
  created_at: number;
}

export interface EndpointRow {
  id: string;
  seller_id: string;
  method: HttpMethod;
  path: string;
  price_micros: number;
  description: string | null;
  response_schema: string | null;
}

export interface TabRow {
  id: string;
  company_id: string;
  label: string | null;
  status: TabStatus;
  policy: string;
  policy_text: string | null;
  hold_cents: number;
  enroll_token_hash: string;
  paypal_order_id: string | null;
  approve_url: string | null;
  authorization_id: string | null;
  authorized_at: number | null;
  honor_until: number | null;
  expires_at: number | null;
  reauthorize_at: number | null;
  reauthorized_at: number | null;
  reauth_authorization_id: string | null;
  close_at: number | null;
  carry_in_micros: number;
  created_at: number;
  closed_at: number | null;
}

export interface ChannelRow {
  tab_id: string;
  seller_id: string;
  last_seq: number;
  last_cumulative_micros: number;
}

export interface VoucherRow {
  id: string;
  tab_id: string;
  seller_id: string;
  endpoint_id: string | null;
  seq: number;
  price_micros: number;
  cumulative_micros: number;
  req_hash: string;
  method: string;
  path: string;
  agent_id: string | null;
  task_id: string | null;
  status: "pending" | VoucherStatus;
  void_reason: string | null;
  http_status: number | null;
  latency_ms: number | null;
  response_bytes: number | null;
  response_excerpt: string | null;
  request_excerpt: string | null;
  signature: string;
  review_id: string | null;
  settlement_id: string | null;
  created_at: number;
}

export interface AlarmRow {
  id: string;
  tab_id: string;
  kind: AlarmKind;
  message: string;
  detail: string;
  status: AlarmDTO["status"];
  created_at: number;
}

export interface ReviewRow {
  id: string;
  tab_id: string;
  alarm_id: string | null;
  status: ReviewDTO["status"];
  verdict: ReviewVerdict | null;
  fault: ReviewFault | null;
  confidence: number | null;
  reason: string | null;
  voided_voucher_ids: string;
  transcript: string;
  model: string | null;
  decided_by: "ai" | "human" | null;
  created_at: number;
  finished_at: number | null;
}

export interface SettlementRow {
  id: string;
  tab_id: string;
  status: SettlementDTO["status"];
  billable_micros: number;
  charged_cents: number;
  carry_out_micros: number;
  paypal_fee_cents: number;
  capture_id: string | null;
  naive_fee_cents: number;
  call_count: number;
  void_count: number;
  voided_micros: number;
  created_at: number;
  error: string | null;
}

export interface SettlementLineRow {
  settlement_id: string;
  seller_id: string;
  gross_micros: number;
  fee_share_micros: number;
  net_micros: number;
  calls: number;
}

export interface SellerBalanceRow {
  seller_id: string;
  available_micros: number;
  paid_out_micros: number;
  updated_at: number;
}

export interface PayoutRow {
  id: string;
  paypal_batch_id: string | null;
  status: PayoutDTO["status"];
  total_cents: number;
  fee_cents: number;
  created_at: number;
  error: string | null;
}

export interface PayoutItemRow {
  payout_id: string;
  seller_id: string;
  amount_cents: number;
  fee_cents: number;
  paypal_item_id: string | null;
  status: string;
}

export interface PurchaseRow {
  id: string;
  tab_id: string | null;
  title: string;
  amount_cents: number;
  merchant: string | null;
  product_url: string | null;
  image_url: string | null;
  paypal_order_id: string | null;
  approve_url: string | null;
  capture_id: string | null;
  status: PurchaseDTO["status"];
  research_cost_micros: number;
  reasoning: string | null;
  created_at: number;
}

export interface AgentRunRow {
  id: string;
  tab_id: string;
  agent_id: string;
  task: string;
  mode: AgentMode;
  status: AgentRunDTO["status"];
  spent_micros: number;
  result: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface AgentStepRow {
  run_id: string;
  idx: number;
  kind: string;
  text: string;
  data: string | null;
  at: number;
}

// ---------------------------------------------------------------- companies & sellers

export function companyDTO(row: CompanyRow): CompanyDTO {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export function endpointDTO(row: EndpointRow): EndpointDTO {
  return {
    id: row.id,
    method: row.method,
    path: row.path,
    priceMicros: row.price_micros,
    description: row.description,
    responseSchema: parseJson<Record<string, unknown> | null>(row.response_schema, null),
  };
}

export function voidRulesOf(row: Pick<SellerRow, "void_rules">): VoidRules {
  return { ...DEFAULT_VOID_RULES, ...parseJson<Partial<VoidRules>>(row.void_rules, {}) };
}

/** Where agents call a seller through the paywall. */
export function sellerGatewayUrl(publicBaseUrl: string, sellerId: string): string {
  return `${publicBaseUrl}/s/${sellerId}`;
}

export function sellerDTO(db: Db, row: SellerRow, publicBaseUrl: string): SellerDTO {
  const endpoints = stmt(db, "SELECT * FROM endpoints WHERE seller_id = ? ORDER BY method, path").all(row.id) as EndpointRow[];
  const balance = stmt(db, "SELECT * FROM seller_balances WHERE seller_id = ?").get(row.id) as SellerBalanceRow | undefined;
  const stats = stmt(
    db,
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(status = 'voided'), 0) AS voids,
            COALESCE(SUM(CASE WHEN status = 'accepted' THEN price_micros END), 0) AS gross
       FROM vouchers WHERE seller_id = ? AND status != 'pending'`,
  ).get(row.id) as { calls: number; voids: number; gross: number };
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    authHeader: row.auth_header,
    hasApiKey: row.api_key_enc != null,
    paypalEmail: row.paypal_email,
    voidRules: voidRulesOf(row),
    status: row.status,
    endpoints: endpoints.map(endpointDTO),
    gatewayUrl: sellerGatewayUrl(publicBaseUrl, row.id),
    balanceMicros: balance?.available_micros ?? 0,
    paidOutMicros: balance?.paid_out_micros ?? 0,
    createdAt: row.created_at,
    stats: { calls: stats.calls, voids: stats.voids, grossMicros: stats.gross },
  };
}

export function getSellerDTO(db: Db, id: string, publicBaseUrl: string): SellerDTO | null {
  const row = stmt(db, "SELECT * FROM sellers WHERE id = ?").get(id) as SellerRow | undefined;
  return row ? sellerDTO(db, row, publicBaseUrl) : null;
}

export function catalogEntryDTO(seller: SellerDTO): CatalogEntryDTO {
  return {
    sellerId: seller.id,
    sellerName: seller.name,
    gatewayUrl: seller.gatewayUrl,
    voidRules: seller.voidRules,
    endpoints: seller.endpoints,
  };
}

// ---------------------------------------------------------------- tabs

const TAB_SELECT = "SELECT t.*, c.name AS company_name FROM tabs t LEFT JOIN companies c ON c.id = t.company_id";

/** Totals over the tab's judged vouchers. `now` is the gateway clock (for today's spend, UTC day). */
export function tabTotals(db: Db, tab: Pick<TabRow, "id" | "hold_cents">, now: number): TabTotalsDTO {
  const r = stmt(
    db,
    `SELECT COALESCE(SUM(status = 'accepted'), 0) AS accepted,
            COALESCE(SUM(status = 'voided'), 0) AS voided,
            COALESCE(SUM(CASE WHEN status = 'accepted' THEN price_micros END), 0) AS billable,
            COALESCE(SUM(CASE WHEN status = 'voided' THEN price_micros END), 0) AS voided_micros,
            COALESCE(SUM(CASE WHEN status = 'accepted' AND created_at >= ? THEN price_micros END), 0) AS today
       FROM vouchers WHERE tab_id = ?`,
  ).get(startOfUtcDay(now), tab.id) as { accepted: number; voided: number; billable: number; voided_micros: number; today: number };
  return {
    calls: r.accepted + r.voided,
    accepted: r.accepted,
    voided: r.voided,
    billableMicros: r.billable,
    voidedMicros: r.voided_micros,
    remainingMicros: Math.max(0, tab.hold_cents * MICROS_PER_CENT - r.billable),
    spentTodayMicros: r.today,
  };
}

export function tabDTO(db: Db, row: TabRow & { company_name?: string | null }, now: number): TabDTO {
  return {
    id: row.id,
    companyId: row.company_id,
    companyName: row.company_name ?? null,
    label: row.label,
    status: row.status,
    policy: parseJson<Policy>(row.policy, DEFAULT_POLICY),
    policyText: row.policy_text,
    holdCents: row.hold_cents,
    paypal: {
      orderId: row.paypal_order_id,
      authorizationId: row.authorization_id,
      reauthorizationId: row.reauth_authorization_id,
      approveUrl: row.approve_url,
    },
    authorizedAt: row.authorized_at,
    honorUntil: row.honor_until,
    expiresAt: row.expires_at,
    reauthorizedAt: row.reauthorized_at,
    reauthorizeAt: row.reauthorize_at,
    closeAt: row.close_at,
    closedAt: row.closed_at,
    carryInMicros: row.carry_in_micros,
    createdAt: row.created_at,
    totals: tabTotals(db, row, now),
  };
}

export function getTabDTO(db: Db, id: string, now: number): TabDTO | null {
  const row = stmt(db, `${TAB_SELECT} WHERE t.id = ?`).get(id) as (TabRow & { company_name: string | null }) | undefined;
  return row ? tabDTO(db, row, now) : null;
}

/** Newest first. */
export function listTabDTOs(db: Db, now: number, filter: { companyId?: string; statuses?: TabStatus[] } = {}): TabDTO[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.companyId) {
    where.push("t.company_id = ?");
    params.push(filter.companyId);
  }
  if (filter.statuses?.length) {
    where.push(`t.status IN (${filter.statuses.map(() => "?").join(", ")})`);
    params.push(...filter.statuses);
  }
  const sql = `${TAB_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY t.created_at DESC`;
  const rows = db.prepare(sql).all(...params) as Array<TabRow & { company_name: string | null }>;
  return rows.map((row) => tabDTO(db, row, now));
}

export function channelDTO(row: ChannelRow): ChannelDTO {
  return { sellerId: row.seller_id, lastSeq: row.last_seq, lastCumulativeMicros: row.last_cumulative_micros };
}

// ---------------------------------------------------------------- vouchers, alarms, reviews

/** Callers never pass 'pending' rows (filter them in SQL). */
export function voucherDTO(row: VoucherRow): VoucherDTO {
  return {
    id: row.id,
    tabId: row.tab_id,
    sellerId: row.seller_id,
    endpointId: row.endpoint_id,
    seq: row.seq,
    priceMicros: row.price_micros,
    cumulativeMicros: row.cumulative_micros,
    method: row.method,
    path: row.path,
    agentId: row.agent_id,
    taskId: row.task_id,
    status: row.status as VoucherStatus,
    voidReason: row.void_reason as VoidReason | null,
    httpStatus: row.http_status,
    latencyMs: row.latency_ms,
    responseBytes: row.response_bytes,
    reviewId: row.review_id,
    settlementId: row.settlement_id,
    createdAt: row.created_at,
  };
}

export function alarmDTO(row: AlarmRow): AlarmDTO {
  return {
    id: row.id,
    tabId: row.tab_id,
    kind: row.kind,
    message: row.message,
    detail: parseJson<Record<string, unknown>>(row.detail, {}),
    status: row.status,
    createdAt: row.created_at,
  };
}

export function reviewDTO(row: ReviewRow): ReviewDTO {
  return {
    id: row.id,
    tabId: row.tab_id,
    alarmId: row.alarm_id,
    status: row.status,
    verdict: row.verdict,
    fault: row.fault,
    confidence: row.confidence,
    reason: row.reason,
    voidedVoucherIds: parseJson<string[]>(row.voided_voucher_ids, []),
    transcript: parseJson<ReviewMessageDTO[]>(row.transcript, []),
    model: row.model,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

// ---------------------------------------------------------------- settlements & payouts

export function settlementLineDTO(row: SettlementLineRow & { seller_name?: string | null }): SettlementLineDTO {
  return {
    sellerId: row.seller_id,
    sellerName: row.seller_name ?? null,
    grossMicros: row.gross_micros,
    feeShareMicros: row.fee_share_micros,
    netMicros: row.net_micros,
    calls: row.calls,
  };
}

export function settlementDTO(db: Db, row: SettlementRow): SettlementDTO {
  const lines = stmt(
    db,
    `SELECT l.*, s.name AS seller_name FROM settlement_lines l LEFT JOIN sellers s ON s.id = l.seller_id
      WHERE l.settlement_id = ? ORDER BY l.gross_micros DESC, l.seller_id`,
  ).all(row.id) as Array<SettlementLineRow & { seller_name: string | null }>;
  return {
    id: row.id,
    tabId: row.tab_id,
    status: row.status,
    billableMicros: row.billable_micros,
    chargedCents: row.charged_cents,
    carryOutMicros: row.carry_out_micros,
    paypalFeeCents: row.paypal_fee_cents,
    captureId: row.capture_id,
    naiveFeeCents: row.naive_fee_cents,
    callCount: row.call_count,
    voidCount: row.void_count,
    voidedMicros: row.voided_micros,
    lines: lines.map(settlementLineDTO),
    createdAt: row.created_at,
    error: row.error,
  };
}

export function getSettlementDTO(db: Db, id: string): SettlementDTO | null {
  const row = stmt(db, "SELECT * FROM settlements WHERE id = ?").get(id) as SettlementRow | undefined;
  return row ? settlementDTO(db, row) : null;
}

export function payoutItemDTO(row: PayoutItemRow & { seller_name?: string | null }): PayoutItemDTO {
  return {
    sellerId: row.seller_id,
    sellerName: row.seller_name ?? null,
    amountCents: row.amount_cents,
    feeCents: row.fee_cents,
    paypalItemId: row.paypal_item_id,
    status: row.status,
  };
}

export function payoutDTO(db: Db, row: PayoutRow): PayoutDTO {
  const items = stmt(
    db,
    `SELECT i.*, s.name AS seller_name FROM payout_items i LEFT JOIN sellers s ON s.id = i.seller_id
      WHERE i.payout_id = ? ORDER BY i.amount_cents DESC, i.seller_id`,
  ).all(row.id) as Array<PayoutItemRow & { seller_name: string | null }>;
  return {
    id: row.id,
    paypalBatchId: row.paypal_batch_id,
    status: row.status,
    totalCents: row.total_cents,
    feeCents: row.fee_cents,
    items: items.map(payoutItemDTO),
    createdAt: row.created_at,
    error: row.error,
  };
}

// ---------------------------------------------------------------- purchases & agent runs

export function purchaseDTO(row: PurchaseRow): PurchaseDTO {
  return {
    id: row.id,
    tabId: row.tab_id,
    title: row.title,
    amountCents: row.amount_cents,
    merchant: row.merchant,
    productUrl: row.product_url,
    imageUrl: row.image_url,
    paypalOrderId: row.paypal_order_id,
    approveUrl: row.approve_url,
    status: row.status,
    researchCostMicros: row.research_cost_micros,
    reasoning: row.reasoning,
    createdAt: row.created_at,
  };
}

export function agentStepDTO(row: AgentStepRow): AgentStepDTO {
  return {
    ...parseJson<Partial<AgentStepDTO>>(row.data, {}),
    runId: row.run_id,
    index: row.idx,
    kind: row.kind as AgentStepKind,
    text: row.text,
    at: row.at,
  };
}

/** Inverse of agentStepDTO: the optional fields go into the JSON `data` column. */
export function agentStepRow(step: AgentStepDTO): AgentStepRow {
  const { runId, index, kind, text, at, ...rest } = step;
  return { run_id: runId, idx: index, kind, text, at, data: Object.keys(rest).length > 0 ? JSON.stringify(rest) : null };
}

export function agentRunDTO(db: Db, row: AgentRunRow, opts: { steps?: boolean } = {}): AgentRunDTO {
  const steps =
    opts.steps === false
      ? []
      : (stmt(db, "SELECT * FROM agent_steps WHERE run_id = ? ORDER BY idx").all(row.id) as AgentStepRow[]).map(agentStepDTO);
  return {
    id: row.id,
    tabId: row.tab_id,
    agentId: row.agent_id,
    task: row.task,
    mode: row.mode,
    status: row.status,
    steps,
    spentMicros: row.spent_micros,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    result: parseJson<AgentRunDTO["result"]>(row.result, null),
    error: row.error,
  };
}
