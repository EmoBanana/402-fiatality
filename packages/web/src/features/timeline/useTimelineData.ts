/**
 * Tabs, payouts and settlements for the timeline, kept live: `tab.updated` (holds approved, reauthorized,
 * rescheduled, closed), `settlement.completed` and `payout.completed` are upserted as they arrive, and
 * everything is refetched after a reconnect.
 */
import type { ConfigDTO, PayoutDTO, SettlementDTO, TabDTO } from "@p402/shared";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";

export interface TimelineData {
  status: "loading" | "ready" | "error";
  error: ApiError | null;
  config: ConfigDTO | null;
  tabs: TabDTO[];
  payouts: PayoutDTO[];
  settlements: SettlementDTO[];
  reload: () => void;
  /** Replace one tab locally (e.g. with the PATCH response) before its event arrives. */
  putTab: (tab: TabDTO) => void;
}

function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i < 0) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
}

export function useTimelineData(): TimelineData {
  const [status, setStatus] = useState<TimelineData["status"]>("loading");
  const [error, setError] = useState<ApiError | null>(null);
  const [config, setConfig] = useState<ConfigDTO | null>(null);
  const [tabs, setTabs] = useState<TabDTO[]>([]);
  const [payouts, setPayouts] = useState<PayoutDTO[]>([]);
  const [settlements, setSettlements] = useState<SettlementDTO[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.allSettled([api.tabs.list({}, signal), api.payouts.list(signal), api.settlements.list({}, signal), api.config(signal)]).then(
      ([t, p, s, c]) => {
        if (signal.aborted) return;
        if (p.status === "fulfilled") setPayouts(p.value);
        if (s.status === "fulfilled") setSettlements(s.value);
        if (c.status === "fulfilled") setConfig(c.value);
        if (t.status === "fulfilled") {
          setTabs(t.value);
          setError(null);
          setStatus("ready");
        } else {
          const reason = t.reason;
          setError(reason instanceof ApiError ? reason : new ApiError(0, "network_error", "Can't reach the gateway."));
          setStatus("error");
        }
      },
    );
    return () => controller.abort();
  }, [reloadKey]);

  useGatewayEvents("tab.updated", (event) => setTabs((list) => upsert(list, event.data)));
  useGatewayEvents("settlement.completed", (event) => setSettlements((list) => upsert(list, event.data)));
  useGatewayEvents("payout.completed", (event) => setPayouts((list) => upsert(list, event.data)));

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);
  useOnReconnect(reload);
  const putTab = useCallback((tab: TabDTO) => setTabs((list) => upsert(list, tab)), []);

  return { status, error, config, tabs, payouts, settlements, reload, putTab };
}
