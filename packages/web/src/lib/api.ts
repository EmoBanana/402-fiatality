/**
 * Typed client for every gateway route (SPEC §5.5). Same origin: Vite proxies /api, /s, /ws and /paypal to
 * the gateway in dev, and the gateway serves the built app in `npm start`.
 *
 *   const tabs = await api.tabs.list();
 *   try { await api.tabs.close(id) } catch (e) { if (e instanceof ApiError) toast(e.message) }
 *
 * Failures throw ApiError (status 0 = gateway unreachable, including the dev proxy's empty 502; see
 * `isGatewayDown`). Mutating calls send `x-p402-admin` when an admin token is stored (only needed when
 * DEMO_MODE=0).
 */
import type {
  AgentKeyRegisterDTO,
  AgentRunCreateDTO,
  AgentRunDTO,
  AlarmDTO,
  ApiErrorDTO,
  CatalogEntryDTO,
  ChatRequestDTO,
  ChatResponseDTO,
  ClockDTO,
  CompanyCreateDTO,
  CompanyDTO,
  ConfigDTO,
  DisputeActionRequestDTO,
  DisputeAdjudicateDTO,
  DisputeDTO,
  DisputeSyncResultDTO,
  GridQueryRequestDTO,
  GridQueryResponseDTO,
  HealthDTO,
  MetricsSummaryDTO,
  MockDisputeCreateDTO,
  OkDTO,
  PayoutDTO,
  PayoutRunDTO,
  PayoutRunResultDTO,
  PolicyParseDTO,
  PurchaseCheckoutDTO,
  PurchaseDTO,
  PurchaseProposalDTO,
  ReviewDecisionDTO,
  ReviewDTO,
  SellerCreateDTO,
  SellerDTO,
  SellerEarningsDTO,
  SellerUpdateDTO,
  SettlementDTO,
  StatementDTO,
  TabCreateDTO,
  TabCreatedDTO,
  TabDetailDTO,
  TabDTO,
  TabScheduleDTO,
  TimeseriesPointDTO,
  VoucherDTO,
  VoucherQueryDTO,
} from "@p402/shared";

export class ApiError extends Error {
  override name = "ApiError";
  /** HTTP status; 0 when the gateway could not be reached. */
  readonly status: number;
  /** ApiErrorDTO.error, e.g. "invalid_request", "not_found", "network_error". */
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** True when the gateway could not be reached at all (not running, or the dev proxy has nothing to talk to). */
export function isGatewayDown(err: unknown): boolean {
  return err instanceof ApiError && err.status === 0;
}

const ADMIN_TOKEN_KEY = "p402.adminToken";

export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the token lasts for this page only
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

export async function request<T>(method: "GET" | "POST" | "PATCH", path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  // Fastify rejects an empty body sent as JSON, so bodiless POSTs carry no content-type.
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET") {
    const token = getAdminToken();
    if (token) headers["x-p402-admin"] = token;
  }

  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", "Can't reach the gateway. Is `npm run dev` running?");
  }

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    // The Vite dev proxy answers 502 with an empty body when the gateway isn't running: same as unreachable.
    if (data === undefined && res.status >= 502 && res.status <= 504) {
      throw new ApiError(0, "network_error", "Can't reach the gateway. Is `npm run dev` running?");
    }
    const e = (data ?? {}) as Partial<ApiErrorDTO>;
    throw new ApiError(res.status, e.error ?? `http_${res.status}`, e.message ?? (res.statusText || "Request failed"), e.details);
  }
  return data as T;
}

const get = <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>("GET", path, { query, signal });
const post = <T>(path: string, body?: unknown, signal?: AbortSignal) => request<T>("POST", path, { body, signal });
const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, { body });
const seg = encodeURIComponent;

export const api = {
  health: (signal?: AbortSignal) => get<HealthDTO>("/api/health", undefined, signal),
  config: (signal?: AbortSignal) => get<ConfigDTO>("/api/config", undefined, signal),
  catalog: (signal?: AbortSignal) => get<CatalogEntryDTO[]>("/api/catalog", undefined, signal),

  sellers: {
    list: (signal?: AbortSignal) => get<SellerDTO[]>("/api/sellers", undefined, signal),
    create: (body: SellerCreateDTO) => post<SellerDTO>("/api/sellers", body),
    update: (id: string, body: SellerUpdateDTO) => patch<SellerDTO>(`/api/sellers/${seg(id)}`, body),
    earnings: (id: string, signal?: AbortSignal) => get<SellerEarningsDTO>(`/api/sellers/${seg(id)}/earnings`, undefined, signal),
  },

  companies: {
    list: (signal?: AbortSignal) => get<CompanyDTO[]>("/api/companies", undefined, signal),
    create: (body: CompanyCreateDTO) => post<CompanyDTO>("/api/companies", body),
  },

  policy: {
    parse: (text: string, signal?: AbortSignal) => post<PolicyParseDTO>("/api/policy/parse", { text }, signal),
  },

  tabs: {
    list: (query: { companyId?: string } = {}, signal?: AbortSignal) => get<TabDTO[]>("/api/tabs", query, signal),
    get: (id: string, signal?: AbortSignal) => get<TabDetailDTO>(`/api/tabs/${seg(id)}`, undefined, signal),
    /** Places the PayPal hold: open `approveUrl` (see lib/paypal.ts). */
    create: (body: TabCreateDTO) => post<TabCreatedDTO>("/api/tabs", body),
    registerKey: (id: string, body: AgentKeyRegisterDTO) => post<OkDTO>(`/api/tabs/${seg(id)}/keys`, body),
    resume: (id: string) => post<TabDTO>(`/api/tabs/${seg(id)}/resume`),
    freeze: (id: string) => post<TabDTO>(`/api/tabs/${seg(id)}/freeze`),
    /** One PayPal charge for everything billable. */
    close: (id: string) => post<SettlementDTO>(`/api/tabs/${seg(id)}/close`),
    /** Demo only (Bryntum drag-to-reschedule). */
    schedule: (id: string, body: TabScheduleDTO) => patch<TabDTO>(`/api/tabs/${seg(id)}/schedule`, body),
    statement: (id: string, signal?: AbortSignal) => get<StatementDTO>(`/api/tabs/${seg(id)}/statement`, undefined, signal),
  },

  vouchers: {
    list: (query: VoucherQueryDTO = {}, signal?: AbortSignal) => get<VoucherDTO[]>("/api/vouchers", { ...query }, signal),
  },

  alarms: {
    list: (query: { tabId?: string } = {}, signal?: AbortSignal) => get<AlarmDTO[]>("/api/alarms", query, signal),
  },

  reviews: {
    list: (query: { tabId?: string } = {}, signal?: AbortSignal) => get<ReviewDTO[]>("/api/reviews", query, signal),
    decide: (id: string, body: ReviewDecisionDTO) => post<ReviewDTO>(`/api/reviews/${seg(id)}/decide`, body),
  },

  settlements: {
    list: (query: { tabId?: string } = {}, signal?: AbortSignal) => get<SettlementDTO[]>("/api/settlements", query, signal),
  },

  /** PayPal disputes on tabs' charges and the AI jury's hearing of each. */
  disputes: {
    list: (signal?: AbortSignal) => get<DisputeDTO[]>("/api/disputes", undefined, signal),
    get: (id: string, signal?: AbortSignal) => get<DisputeDTO>(`/api/disputes/${seg(id)}`, undefined, signal),
    /** Pulls new and changed disputes from PayPal, or just the case `disputeId` (PayPal's search can lag). */
    sync: (disputeId?: string) => post<DisputeSyncResultDTO>("/api/disputes/sync", disputeId ? { disputeId } : undefined),
    /** Runs the AI jury again; its messages stream as `dispute.message`. */
    rehear: (id: string) => post<DisputeDTO>(`/api/disputes/${seg(id)}/jury`),
    act: (id: string, body: DisputeActionRequestDTO) => post<DisputeDTO>(`/api/disputes/${seg(id)}/actions`, body),
    /** Sandbox and mock only: settle the dispute for the demo. */
    adjudicate: (id: string, body: DisputeAdjudicateDTO) => post<DisputeDTO>(`/api/disputes/${seg(id)}/adjudicate`, body),
    /** Mock mode only: the buyer opens a dispute on a settled tab's charge. */
    simulate: (body: MockDisputeCreateDTO) => post<DisputeDTO>("/api/disputes/mock", body),
  },

  payouts: {
    list: (signal?: AbortSignal) => get<PayoutDTO[]>("/api/payouts", undefined, signal),
    run: (body: PayoutRunDTO = {}) => post<PayoutRunResultDTO>("/api/payouts/run", body),
  },

  agentRuns: {
    list: (query: { tabId?: string } = {}, signal?: AbortSignal) => get<AgentRunDTO[]>("/api/agent/runs", query, signal),
    create: (body: AgentRunCreateDTO) => post<AgentRunDTO>("/api/agent/runs", body),
    get: (id: string, signal?: AbortSignal) => get<AgentRunDTO>(`/api/agent/runs/${seg(id)}`, undefined, signal),
    stop: (id: string) => post<AgentRunDTO>(`/api/agent/runs/${seg(id)}/stop`),
  },

  purchases: {
    list: (query: { tabId?: string } = {}, signal?: AbortSignal) => get<PurchaseDTO[]>("/api/purchases", query, signal),
    create: (body: PurchaseProposalDTO) => post<PurchaseDTO>("/api/purchases", body),
    /** Creates the PayPal CAPTURE order: open `approveUrl` (see lib/paypal.ts). */
    checkout: (id: string) => post<PurchaseCheckoutDTO>(`/api/purchases/${seg(id)}/checkout`),
  },

  metrics: {
    summary: (signal?: AbortSignal) => get<MetricsSummaryDTO>("/api/metrics/summary", undefined, signal),
    /** `bucket` in seconds. */
    timeseries: (query: { minutes?: number; bucket?: number } = {}, signal?: AbortSignal) =>
      get<TimeseriesPointDTO[]>("/api/metrics/timeseries", query, signal),
  },

  clock: {
    get: (signal?: AbortSignal) => get<ClockDTO>("/api/clock", undefined, signal),
    /** Demo only. The gateway runs the settlement scheduler right after. */
    advance: (ms: number) => post<ClockDTO>("/api/clock/advance", { ms }),
  },

  ai: {
    gridQuery: (body: GridQueryRequestDTO, signal?: AbortSignal) => post<GridQueryResponseDTO>("/api/ai/grid-query", body, signal),
    chat: (body: ChatRequestDTO, signal?: AbortSignal) => post<ChatResponseDTO>("/api/ai/chat", body, signal),
  },
};
