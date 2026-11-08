/**
 * LedgerFeed: loads the terminal's data, then keeps it live from gateway events.
 *
 * Vouchers never pass through React state: they go into AG Grid with `applyTransactionAsync` (adds for new
 * ids, updates for known ids, e.g. an AI review voiding an accepted IOU), batched per microtask and deduped
 * by id, with getRowId = voucher id. Everything else lands in TerminalStore slices.
 *
 * Reviews: the gateway sets voucher.reviewId on IOUs a review voided. The review also reads the tab's last
 * 25 vouchers as evidence (SPEC §5.4), so the feed links those to the review too; together they become the
 * master rows whose detail shows the debate transcript.
 */
import type { AgentRunDTO, GatewayEvent, GatewayEventType, ReviewDTO, VoucherDTO } from "@p402/shared";
import type { GridApi } from "ag-grid-community";
import { ApiError, api } from "../../lib/api";
import { subscribe } from "../../lib/events";
import { rowReview } from "./labels";
import { PulseModel } from "./pulse";
import { type FeedQueries, newestFirst, type Problem, type RunInfo, TerminalStore, upsertById, type VoucherRow } from "./store";

/** SPEC §5.4: a review reads the tab's last 25 vouchers. */
const EVIDENCE_WINDOW = 25;
const PAGE_SIZE = 1000;

const EVENT_TYPES = [
  "voucher.accepted",
  "voucher.voided",
  "alarm.raised",
  "review.started",
  "review.message",
  "review.finished",
  "settlement.completed",
  "payout.completed",
  "seller.updated",
  "agent.step",
  "agent.finished",
  "clock.advanced",
  "metrics",
] as const satisfies readonly GatewayEventType[];

type FeedEvent = Extract<GatewayEvent, { type: (typeof EVENT_TYPES)[number] }>;

function toRunInfo(run: AgentRunDTO): RunInfo {
  return { id: run.id, task: run.task, agentId: run.agentId, mode: run.mode, status: run.status };
}

function describeProblem(err: unknown): Problem {
  if (err instanceof ApiError) {
    if (err.status === 0) return { kind: "offline", message: "Can't reach the gateway. Start it with `npm run dev`." };
    if (err.status === 503) return { kind: "not_wired", message: err.message || "This gateway service isn't wired yet." };
    return { kind: "error", message: err.message };
  }
  return { kind: "error", message: err instanceof Error ? err.message : "Something went wrong." };
}

export class LedgerFeed implements FeedQueries {
  readonly store = new TerminalStore();

  private rows = new Map<string, VoucherRow>();
  private reviewIndex = new Map<string, ReviewDTO>();
  /** voucherId -> reviewId for links the feed derived (evidence windows and voidedVoucherIds). */
  private evidence = new Map<string, string>();
  private pulse = new PulseModel();

  private grid: GridApi<VoucherRow> | null = null;
  private gridSynced = false;
  private pending: { add: Map<string, VoucherRow>; update: Map<string, VoucherRow> } | null = null;

  private loadedOnce = false;
  private buffer: VoucherDTO[] = [];
  private loadSeq = 0;
  private loadStartedAt = 0;
  private touched = new Map<string, number>();
  private controller: AbortController | null = null;
  private metricsAt = 0;

  private runRequests = new Set<string>();
  private timers = new Map<string, number>();
  private pulseTimer = 0;
  private labelFrame = 0;
  private stopFns: Array<() => void> = [];

  // ------------------------------------------------------------------ lifecycle

  /** Subscribe to events and load. Returns the cleanup (StrictMode-safe: start/stop/start works). */
  start(): () => void {
    this.stop();
    this.stopFns.push(subscribe(EVENT_TYPES, (event) => this.onEvent(event as FeedEvent)));
    const roll = window.setInterval(() => this.commitPulse(), 15_000);
    this.stopFns.push(() => window.clearInterval(roll));
    void this.load();
    return () => this.stop();
  }

  private stop(): void {
    for (const fn of this.stopFns.splice(0)) fn();
    this.controller?.abort();
    this.controller = null;
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    if (this.pulseTimer) window.clearTimeout(this.pulseTimer);
    this.pulseTimer = 0;
    if (this.labelFrame) cancelAnimationFrame(this.labelFrame);
    this.labelFrame = 0;
  }

  attachGrid(grid: GridApi<VoucherRow>): void {
    this.grid = grid;
    this.gridSynced = false;
    this.syncGrid();
  }

  detachGrid(grid: GridApi<VoucherRow>): void {
    if (this.grid !== grid) return;
    this.grid = null;
    this.gridSynced = false;
    this.pending = null;
  }

  // ------------------------------------------------------------------ loading

  async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;
    this.loadStartedAt = Date.now();
    if (!this.loadedOnce) this.store.set({ phase: "loading" });

    const [vouchers, sellers, runs, reviews, alarms, settlements, payouts, metrics, series, clock] = await Promise.allSettled([
      api.vouchers.list({ limit: PAGE_SIZE }, signal),
      api.sellers.list(signal),
      api.agentRuns.list({}, signal),
      api.reviews.list({}, signal),
      api.alarms.list({}, signal),
      api.settlements.list({}, signal),
      api.payouts.list(signal),
      api.metrics.summary(signal),
      api.metrics.timeseries({ minutes: 60, bucket: 60 }, signal),
      api.clock.get(signal),
    ]);
    if (seq !== this.loadSeq || signal.aborted) return;

    const ok = <T>(r: PromiseSettledResult<T>): T | undefined => (r.status === "fulfilled" ? r.value : undefined);
    const state = this.store.getState();

    const sellerList = ok(sellers);
    const sellerMap = sellerList ? new Map(sellerList.map((s) => [s.id, s])) : state.sellers;
    const runMap = new Map(state.runs);
    for (const run of ok(runs) ?? []) runMap.set(run.id, toRunInfo(run));
    const reviewList = ok(reviews);
    if (reviewList) this.reviewIndex = new Map(reviewList.map((r) => [r.id, r]));
    const clockDto = ok(clock);

    // Vouchers: upsert (a reload keeps older rows the first page doesn't cover), skipping rows that a live
    // event changed while this request was in flight.
    const voucherList = ok(vouchers) ?? [];
    for (const dto of voucherList) {
      const touchedAt = this.touched.get(dto.id);
      if (touchedAt !== undefined && touchedAt >= this.loadStartedAt) continue;
      this.rows.set(dto.id, this.enrich(dto));
    }
    this.touched.clear();
    for (const review of [...this.reviewIndex.values()].sort((a, b) => a.createdAt - b.createdAt)) this.linkEvidence(review);
    for (const [id, row] of this.rows) this.rows.set(id, this.enrich(row));

    this.pulse.reset(sellerMap.values(), ok(series) ?? []);
    for (const row of this.rows.values()) this.pulse.ensure(row.sellerId);

    const problem = vouchers.status === "rejected" ? describeProblem(vouchers.reason) : null;
    const metricsDto = ok(metrics);
    this.store.set({
      phase: "ready",
      problem,
      sellers: sellerMap,
      runs: runMap,
      reviews: newestFirst([...this.reviewIndex.values()]),
      alarms: newestFirst(ok(alarms) ?? state.alarms),
      settlements: newestFirst(ok(settlements) ?? state.settlements),
      payouts: newestFirst(ok(payouts) ?? state.payouts),
      metrics: metricsDto && this.metricsAt < this.loadStartedAt ? metricsDto : state.metrics,
      clockOffsetMs: clockDto?.offsetMs ?? state.clockOffsetMs,
    });

    for (const row of this.rows.values()) if (row.taskId && !runMap.has(row.taskId)) this.fetchRun(row.taskId);

    this.loadedOnce = true;
    this.gridSynced = false;
    this.syncGrid();
    for (const dto of this.buffer.splice(0)) this.upsertVoucher(dto, true);
    this.commitPulse();
  }

  /** Fetch the next 1,000 older IOUs into the grid. Resolves with how many arrived. */
  async loadOlder(): Promise<number> {
    let oldest = Infinity;
    for (const row of this.rows.values()) oldest = Math.min(oldest, row.createdAt);
    const page = await api.vouchers.list({ limit: PAGE_SIZE, before: Number.isFinite(oldest) ? oldest : undefined });
    let added = 0;
    for (const dto of page) {
      if (!this.rows.has(dto.id)) added += 1;
      this.upsertVoucher(dto, false);
    }
    this.commitPulse();
    return added;
  }

  // ------------------------------------------------------------------ events

  private onEvent(event: FeedEvent): void {
    switch (event.type) {
      case "voucher.accepted":
      case "voucher.voided":
        this.upsertVoucher(event.data, true);
        break;
      case "alarm.raised":
        this.store.set({ alarms: upsertById(this.store.getState().alarms, event.data) });
        break;
      case "review.started":
        this.putReview(event.data);
        this.store.set({ focusedReviewId: null });
        break;
      case "review.message": {
        const { reviewId, tabId, message } = event.data;
        const current = this.reviewIndex.get(reviewId);
        const base: ReviewDTO = current ?? {
          id: reviewId,
          tabId,
          status: "running",
          voidedVoucherIds: [],
          transcript: [],
          createdAt: message.at,
        };
        const seen = base.transcript.some((m) => m.role === message.role && m.at === message.at && m.content === message.content);
        if (!seen) this.putReview({ ...base, transcript: [...base.transcript, message] });
        break;
      }
      case "review.finished":
        this.putReview(event.data);
        break;
      case "settlement.completed":
        this.store.set({ settlements: upsertById(this.store.getState().settlements, event.data) });
        // Settled IOUs now carry a settlementId and seller balances moved.
        this.debounce("vouchers", 600, () => void this.refreshVouchers());
        this.debounce("sellers", 600, () => void this.refreshSellers());
        break;
      case "payout.completed":
        this.store.set({ payouts: upsertById(this.store.getState().payouts, event.data) });
        this.debounce("sellers", 600, () => void this.refreshSellers());
        break;
      case "seller.updated": {
        const sellers = new Map(this.store.getState().sellers);
        sellers.set(event.data.id, event.data);
        this.store.set({ sellers });
        this.pulse.setStats(event.data);
        this.markPulseDirty();
        this.refreshLabels();
        break;
      }
      case "agent.step":
        if (!this.store.getState().runs.has(event.data.runId)) this.fetchRun(event.data.runId);
        break;
      case "agent.finished": {
        const runs = new Map(this.store.getState().runs);
        runs.set(event.data.id, toRunInfo(event.data));
        this.store.set({ runs });
        this.refreshLabels();
        break;
      }
      case "clock.advanced":
        this.store.set({ clockOffsetMs: event.data.offsetMs });
        this.markPulseDirty();
        break;
      case "metrics":
        this.metricsAt = Date.now();
        this.store.set({ metrics: event.data });
        break;
    }
  }

  private upsertVoucher(dto: VoucherDTO, countInPulse: boolean): void {
    if (!this.loadedOnce) {
      this.buffer.push(dto);
      return;
    }
    this.touched.set(dto.id, Date.now());
    const prev = this.rows.get(dto.id);
    if (dto.reviewId && dto.status === "voided") this.evidence.set(dto.id, dto.reviewId);
    const row = this.enrich(dto);
    this.rows.set(row.id, row);
    if (countInPulse) this.pulse.apply(prev, row);
    else this.pulse.ensure(row.sellerId);
    this.markPulseDirty();
    if (row.taskId && !this.store.getState().runs.has(row.taskId)) this.fetchRun(row.taskId);
    if (!this.store.getState().sellers.has(row.sellerId)) this.debounce("sellers", 1_000, () => void this.refreshSellers());
    this.queue(prev ? "update" : "add", row);
  }

  private putReview(review: ReviewDTO): void {
    this.reviewIndex.set(review.id, review);
    this.store.set({ reviews: newestFirst([...this.reviewIndex.values()]) });
    this.linkEvidence(review);
    for (const [id, row] of this.rows) {
      const linked = row.reviewId === review.id || this.evidence.get(id) === review.id;
      if (!linked) continue;
      const next = this.enrich(row);
      if (next.reviewId !== row.reviewId || next.review !== row.review) {
        this.rows.set(id, next);
        this.queue("update", next);
      }
    }
  }

  /** Link the tab's IOUs this review read (its evidence window) and the ones it voided. */
  private linkEvidence(review: ReviewDTO): void {
    const window: VoucherRow[] = [];
    for (const row of this.rows.values()) if (row.tabId === review.tabId && row.createdAt <= review.createdAt) window.push(row);
    window.sort((a, b) => b.createdAt - a.createdAt);
    for (const row of window.slice(0, EVIDENCE_WINDOW)) {
      if (!this.evidence.has(row.id) && !row.reviewId) this.evidence.set(row.id, review.id);
    }
    for (const id of review.voidedVoucherIds ?? []) this.evidence.set(id, review.id);
  }

  private enrich(dto: VoucherDTO): VoucherRow {
    const reviewId = dto.reviewId ?? this.evidence.get(dto.id) ?? null;
    const review = reviewId ? this.reviewIndex.get(reviewId) : undefined;
    return { ...dto, reviewId, review: review ? rowReview(review, dto) : null };
  }

  // ------------------------------------------------------------------ grid

  private syncGrid(): void {
    const grid = this.grid;
    if (!grid || !this.loadedOnce || this.gridSynced) return;
    this.pending = null;
    grid.flushAsyncTransactions();
    grid.setGridOption("rowData", [...this.rows.values()]);
    this.gridSynced = true;
  }

  private queue(kind: "add" | "update", row: VoucherRow): void {
    if (!this.grid || !this.gridSynced) return; // the next syncGrid() carries it
    if (!this.pending) {
      this.pending = { add: new Map(), update: new Map() };
      queueMicrotask(() => this.flush());
    }
    if (kind === "update" && this.pending.add.has(row.id)) this.pending.add.set(row.id, row);
    else this.pending[kind].set(row.id, row);
  }

  private flush(): void {
    const batch = this.pending;
    const grid = this.grid;
    this.pending = null;
    if (!batch || !grid || grid.isDestroyed()) return;
    grid.applyTransactionAsync({ add: [...batch.add.values()], addIndex: 0, update: [...batch.update.values()] }, (result) => {
      if (result.add.length > 0 && !grid.isDestroyed()) grid.flashCells({ rowNodes: result.add });
    });
  }

  /** Re-render cells whose labels come from lookups (seller names, task text). */
  private refreshLabels(): void {
    if (this.labelFrame) return;
    this.labelFrame = requestAnimationFrame(() => {
      this.labelFrame = 0;
      const grid = this.grid;
      if (grid && !grid.isDestroyed()) grid.refreshCells({ force: true });
    });
  }

  // ------------------------------------------------------------------ lookups and refreshes

  private fetchRun(id: string): void {
    if (this.runRequests.has(id)) return;
    this.runRequests.add(id);
    api.agentRuns
      .get(id)
      .then((run) => {
        const runs = new Map(this.store.getState().runs);
        runs.set(run.id, toRunInfo(run));
        this.store.set({ runs });
        this.refreshLabels();
      })
      .catch(() => {
        // Unknown run (e.g. a CLI agent): the task column falls back to the id. Retry on a later sighting.
        window.setTimeout(() => this.runRequests.delete(id), 30_000);
      });
  }

  private async refreshSellers(): Promise<void> {
    try {
      const list = await api.sellers.list();
      this.store.set({ sellers: new Map(list.map((s) => [s.id, s])) });
      for (const seller of list) this.pulse.setStats(seller);
      this.markPulseDirty();
      this.refreshLabels();
    } catch {
      // keep the previous names; the next event retries
    }
  }

  private async refreshVouchers(): Promise<void> {
    try {
      const list = await api.vouchers.list({ limit: PAGE_SIZE });
      for (const dto of list) this.upsertVoucher(dto, false);
    } catch {
      // live events keep flowing; settlement ids fill in on the next reload
    }
  }

  private debounce(key: string, ms: number, fn: () => void): void {
    const existing = this.timers.get(key);
    if (existing) window.clearTimeout(existing);
    this.timers.set(
      key,
      window.setTimeout(() => {
        this.timers.delete(key);
        fn();
      }, ms),
    );
  }

  private markPulseDirty(): void {
    if (this.pulseTimer) return;
    this.pulseTimer = window.setTimeout(() => {
      this.pulseTimer = 0;
      this.commitPulse();
    }, 500);
  }

  private commitPulse(): void {
    const store = this.store;
    store.set({
      pulse: this.pulse.rows(store.now(), (id) => store.sellerName(id)),
      voucherCount: this.rows.size,
    });
  }

  // ------------------------------------------------------------------ queries for components

  focusReview(id: string | null): void {
    this.store.set({ focusedReviewId: id });
  }

  applyReview(review: ReviewDTO): void {
    this.putReview(review);
  }

  /** IOUs linked to a review (evidence + voided), newest first. */
  rowsForReview(reviewId: string): VoucherRow[] {
    const out: VoucherRow[] = [];
    for (const row of this.rows.values()) if (row.reviewId === reviewId) out.push(row);
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }
}
