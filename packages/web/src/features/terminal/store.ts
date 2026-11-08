/**
 * Terminal state outside React. The feed (feed.ts) writes it; components read slices with
 * `useTerminal(selector)`, so a voucher burst never re-renders the page: vouchers go straight into AG Grid
 * through transactions, and only the small slices below (reviews, alarms, settlements, pulse, metrics) are
 * React state. Every update replaces the slice it touches, so selectors can return slices as-is.
 */
import type {
  AgentRunDTO,
  AlarmDTO,
  MetricsSummaryDTO,
  PayoutDTO,
  ReviewDTO,
  SellerDTO,
  SettlementDTO,
  VoucherDTO,
} from "@p402/shared";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { RowReview } from "./labels";

/** A voucher as the grid holds it: the DTO plus the state of the review it went through, if any. */
export interface VoucherRow extends VoucherDTO {
  /** Review that examined this IOU: the gateway's reviewId, or the review whose evidence window covered it. */
  reviewId: string | null;
  /** What that review meant for this IOU (null when never reviewed). */
  review: RowReview | null;
}

export interface RunInfo {
  id: string;
  task: string;
  agentId: string;
  mode: AgentRunDTO["mode"];
  status: AgentRunDTO["status"];
}

export interface Problem {
  /** offline: gateway unreachable; not_wired: the route exists but its service isn't wired yet (503). */
  kind: "offline" | "not_wired" | "error";
  message: string;
}

export interface SellerPulseRow {
  sellerId: string;
  name: string;
  /** Billable dollars per minute for the last 60 minutes, oldest first. */
  series: number[];
  spend60Micros: number;
  calls: number;
  voids: number;
  billableMicros: number;
}

export interface TerminalState {
  phase: "loading" | "ready";
  problem: Problem | null;
  metrics: MetricsSummaryDTO | null;
  sellers: ReadonlyMap<string, SellerDTO>;
  runs: ReadonlyMap<string, RunInfo>;
  /** Newest first. */
  reviews: readonly ReviewDTO[];
  /** Newest first. */
  alarms: readonly AlarmDTO[];
  /** Newest first. */
  settlements: readonly SettlementDTO[];
  /** Newest first. */
  payouts: readonly PayoutDTO[];
  pulse: readonly SellerPulseRow[];
  voucherCount: number;
  /** Gateway demo clock offset (vouchers are stamped with gateway time). */
  clockOffsetMs: number;
  /** Review shown in the side panel; null = follow the live one. */
  focusedReviewId: string | null;
}

const EMPTY_MAP = new Map<never, never>();

const INITIAL_STATE: TerminalState = {
  phase: "loading",
  problem: null,
  metrics: null,
  sellers: EMPTY_MAP,
  runs: EMPTY_MAP,
  reviews: [],
  alarms: [],
  settlements: [],
  payouts: [],
  pulse: [],
  voucherCount: 0,
  clockOffsetMs: 0,
  focusedReviewId: null,
};

export class TerminalStore {
  private state: TerminalState = INITIAL_STATE;
  private listeners = new Set<() => void>();

  getState = (): TerminalState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(patch: Partial<TerminalState>): void {
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof TerminalState>) {
      if (this.state[key] !== patch[key]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Gateway "now" (the demo clock may be fast-forwarded). */
  now(): number {
    return Date.now() + this.state.clockOffsetMs;
  }

  sellerName(id: string | null | undefined): string {
    if (!id) return "";
    return this.state.sellers.get(id)?.name ?? id;
  }

  taskLabel(runId: string | null | undefined): string {
    if (!runId) return "";
    return this.state.runs.get(runId)?.task ?? runId;
  }

  review(id: string | null | undefined): ReviewDTO | undefined {
    if (!id) return undefined;
    return this.state.reviews.find((r) => r.id === id);
  }
}

/** What components may ask of the feed (implemented by LedgerFeed). */
export interface FeedQueries {
  readonly store: TerminalStore;
  /** IOUs linked to a review (evidence window + voided), newest first. */
  rowsForReview(reviewId: string): VoucherRow[];
  /** Reload everything (retry, reconnect). */
  load(): Promise<void>;
  /** Append the next 1,000 older IOUs; resolves with how many were new. */
  loadOlder(): Promise<number>;
  /** Show this review in the side panel (null = follow the live one). */
  focusReview(id: string | null): void;
  /** Apply a review returned by a human decision (the gateway's review.finished event may follow). */
  applyReview(review: ReviewDTO): void;
}

export const TerminalContext = createContext<FeedQueries | null>(null);

export function useFeed(): FeedQueries {
  const feed = useContext(TerminalContext);
  if (!feed) throw new Error("useFeed() must be used inside <TerminalContext.Provider>");
  return feed;
}

export function useTerminalStore(): TerminalStore {
  return useFeed().store;
}

/** Subscribe to one slice. The selector must return state as stored (or a primitive), never a new object. */
export function useTerminal<T>(selector: (state: TerminalState) => T): T {
  const store = useTerminalStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(INITIAL_STATE),
  );
}

/** Insert or replace by id, keeping newest-first order by createdAt. */
export function upsertById<T extends { id: string; createdAt: number }>(list: readonly T[], item: T): T[] {
  const next = list.filter((x) => x.id !== item.id);
  const index = next.findIndex((x) => x.createdAt < item.createdAt);
  if (index < 0) next.push(item);
  else next.splice(index, 0, item);
  return next;
}

export function newestFirst<T extends { createdAt: number }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}
