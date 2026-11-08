/**
 * Everything the Insights page reads, kept live from the gateway's event stream.
 *
 * Loads sellers, tabs, the latest 1,000 vouchers, settlements and the spend time series for the chosen
 * range. Voucher events are batched (one render per 400 ms) and trigger a throttled time-series refetch;
 * settlements, tabs and sellers are upserted from their events. If the time-series route fails, the
 * series is rebuilt locally from the vouchers so the chart still works.
 */
import type { ConfigDTO, SellerDTO, SettlementDTO, TabDTO, TimeseriesPointDTO, VoucherDTO } from "@p402/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";
import { aggregateVouchers, type RangeId, rangeOption } from "./metrics";

export const VOUCHER_LIMIT = 1_000;

export interface InsightsData {
  status: "loading" | "ready" | "error";
  /** Why nothing could be loaded (status 0 = gateway unreachable, 503 = route not wired yet). */
  error: ApiError | null;
  config: ConfigDTO | null;
  sellers: SellerDTO[];
  tabs: TabDTO[];
  vouchers: VoucherDTO[];
  settlements: SettlementDTO[];
  points: TimeseriesPointDTO[];
  /** "gateway" when the series came from /api/metrics/timeseries, "local" when rebuilt from vouchers. */
  pointsSource: "gateway" | "local";
  /** True while a range change is refetching (keep the previous render, dimmed). */
  refreshing: boolean;
  /** The voucher list hit the API's 1,000 cap, so voucher-based views cover the latest 1,000 calls. */
  capped: boolean;
  reload: () => void;
}

function upsertById<T extends { id: string }>(list: readonly T[], items: readonly T[], newestFirst = false, cap = Infinity): T[] {
  if (items.length === 0) return list as T[];
  const byId = new Map(list.map((x, i) => [x.id, i]));
  const next = list.slice();
  const fresh: T[] = [];
  for (const item of items) {
    const at = byId.get(item.id);
    if (at === undefined) fresh.push(item);
    else next[at] = item;
  }
  const merged = newestFirst ? [...fresh.reverse(), ...next] : [...next, ...fresh];
  return merged.length > cap ? merged.slice(0, cap) : merged;
}

function toApiError(reason: unknown): ApiError {
  if (reason instanceof ApiError) return reason;
  return new ApiError(0, "network_error", reason instanceof Error ? reason.message : "Request failed");
}

export function useInsightsData(rangeId: RangeId, now: number): InsightsData {
  const [status, setStatus] = useState<InsightsData["status"]>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [sellers, setSellers] = useState<SellerDTO[]>([]);
  const [tabs, setTabs] = useState<TabDTO[]>([]);
  const [vouchers, setVouchers] = useState<VoucherDTO[]>([]);
  const [settlements, setSettlements] = useState<SettlementDTO[]>([]);
  const [gatewayPoints, setGatewayPoints] = useState<TimeseriesPointDTO[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [seriesKey, setSeriesKey] = useState(0);

  const range = rangeOption(rangeId);
  const nowRef = useRef(now);
  nowRef.current = now;

  // ------------------------------------------------------------ initial load (and reload)
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.allSettled([
      api.sellers.list(signal),
      api.tabs.list({}, signal),
      api.vouchers.list({ limit: VOUCHER_LIMIT }, signal),
      api.settlements.list({}, signal),
      api.config(signal),
    ]).then(([s, t, v, st, c]) => {
      if (signal.aborted) return;
      if (s.status === "fulfilled") setSellers(s.value);
      if (t.status === "fulfilled") setTabs(t.value);
      if (v.status === "fulfilled") setVouchers(v.value);
      if (st.status === "fulfilled") setSettlements(st.value);
      if (c.status === "fulfilled") setConfig(c.value);
      // The page is only an error when neither ledger source answered.
      if (v.status === "rejected" && st.status === "rejected") {
        setError(toApiError(v.reason));
        setStatus("error");
      } else {
        setError(null);
        setStatus("ready");
      }
    });
    return () => controller.abort();
  }, [reloadKey]);

  // ------------------------------------------------------------ time series for the chosen range
  // Dim the chart only while a range change (or reload) is in flight, not on the live refreshes.
  const seriesFor = `${range.minutes}:${range.bucketSec}:${reloadKey}`;
  const lastSeriesFor = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    if (lastSeriesFor.current !== seriesFor) {
      lastSeriesFor.current = seriesFor;
      setRefreshing(true);
    }
    api.metrics
      .timeseries({ minutes: range.minutes, bucket: range.bucketSec }, controller.signal)
      .then((points) => {
        if (!controller.signal.aborted) setGatewayPoints(Array.isArray(points) ? points : null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setGatewayPoints(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRefreshing(false);
      });
    return () => controller.abort();
  }, [range.minutes, range.bucketSec, reloadKey, seriesKey, seriesFor]);

  // ------------------------------------------------------------ live updates
  const pending = useRef<VoucherDTO[]>([]);
  const flushTimer = useRef<number | null>(null);
  const seriesTimer = useRef<number | null>(null);
  const lastSeriesAt = useRef(0);

  const scheduleSeriesRefresh = useCallback(() => {
    if (seriesTimer.current !== null) return;
    const wait = Math.max(0, 3_000 - (Date.now() - lastSeriesAt.current));
    seriesTimer.current = window.setTimeout(() => {
      seriesTimer.current = null;
      lastSeriesAt.current = Date.now();
      setSeriesKey((k) => k + 1);
    }, wait);
  }, []);

  useEffect(
    () => () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      if (seriesTimer.current !== null) window.clearTimeout(seriesTimer.current);
    },
    [],
  );

  useGatewayEvents(["voucher.accepted", "voucher.voided"], (event) => {
    pending.current.push(event.data);
    if (flushTimer.current === null) {
      flushTimer.current = window.setTimeout(() => {
        flushTimer.current = null;
        const batch = pending.current;
        pending.current = [];
        setVouchers((list) => upsertById(list, batch, true, VOUCHER_LIMIT));
      }, 400);
    }
    scheduleSeriesRefresh();
  });
  useGatewayEvents("settlement.completed", (event) => setSettlements((list) => upsertById(list, [event.data])));
  useGatewayEvents("tab.updated", (event) => setTabs((list) => upsertById(list, [event.data])));
  useGatewayEvents("seller.updated", (event) => setSellers((list) => upsertById(list, [event.data])));

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useOnReconnect(reload);

  // ------------------------------------------------------------ fallback series
  // Recomputed when vouchers or the range change; `now` (read through a ref) only moves the window edge.
  const localPoints = useMemo(
    () => (gatewayPoints ? null : aggregateVouchers(vouchers, range, nowRef.current)),
    [gatewayPoints, vouchers, range],
  );

  return {
    status,
    error,
    config,
    sellers,
    tabs,
    vouchers,
    settlements,
    points: gatewayPoints ?? localPoints ?? [],
    pointsSource: gatewayPoints ? "gateway" : "local",
    refreshing,
    capped: vouchers.length >= VOUCHER_LIMIT,
    reload,
  };
}
