/**
 * One tab, live: detail (alarms, reviews, settlements), agent runs and purchases, kept current from /ws.
 * Voucher bursts trigger a throttled refetch of the tab (the gateway owns the totals); everything else is
 * applied from the event payloads. Reconnects refetch everything (missed events are not replayed).
 */
import type { AgentRunDTO, AgentStepDTO, PurchaseDTO, ReviewDTO, TabDetailDTO } from "@p402/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";
import { upsertById } from "../../lib/resource";

export interface TabLive {
  tab: TabDetailDTO | undefined;
  runs: AgentRunDTO[];
  purchases: PurchaseDTO[];
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
  setTab: (update: (tab: TabDetailDTO) => TabDetailDTO) => void;
  upsertRun: (run: AgentRunDTO) => void;
  upsertPurchase: (purchase: PurchaseDTO) => void;
}

const REFETCH_EVERY_MS = 800;

function addStep(run: AgentRunDTO, step: AgentStepDTO): AgentRunDTO {
  if (run.steps.some((s) => s.index === step.index)) return run;
  const steps = [...run.steps, step].sort((a, b) => a.index - b.index);
  const spent = step.kind === "paid_call" && step.status === "accepted" && typeof step.costMicros === "number" ? run.spentMicros + step.costMicros : run.spentMicros;
  return { ...run, steps, spentMicros: spent };
}

function upsertReview(list: ReviewDTO[], review: ReviewDTO): ReviewDTO[] {
  const index = list.findIndex((r) => r.id === review.id);
  if (index === -1) return [review, ...list];
  const next = list.slice();
  // Keep streamed messages if the payload carries fewer (events may race).
  const transcript = review.transcript.length >= next[index]!.transcript.length ? review.transcript : next[index]!.transcript;
  next[index] = { ...review, transcript };
  return next;
}

export function useTabLive(tabId: string): TabLive {
  const [tab, setTabState] = useState<TabDetailDTO | undefined>(undefined);
  const [runs, setRuns] = useState<AgentRunDTO[]>([]);
  const [purchases, setPurchases] = useState<PurchaseDTO[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);
  const runIds = useRef(new Set<string>());
  const foreignRuns = useRef(new Set<string>());
  const pendingSteps = useRef(new Map<string, AgentStepDTO[]>());

  const load = useCallback(
    async (initial: boolean) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      if (initial) {
        setTabState(undefined);
        setRuns([]);
        setPurchases([]);
        runIds.current = new Set();
        foreignRuns.current = new Set();
      }
      setLoading(true);
      setError(null);
      try {
        const [detail, runList, purchaseList] = await Promise.all([
          api.tabs.get(tabId, controller.signal),
          api.agentRuns.list({ tabId }, controller.signal).catch(() => [] as AgentRunDTO[]),
          api.purchases.list({ tabId }, controller.signal).catch(() => [] as PurchaseDTO[]),
        ]);
        if (controller.signal.aborted) return;
        setTabState(detail);
        // Filter here too, in case the gateway ignores the tabId query.
        const sortedRuns = runList.filter((r) => r.tabId === tabId).sort((a, b) => b.createdAt - a.createdAt);
        for (const r of sortedRuns) runIds.current.add(r.id);
        setRuns(sortedRuns);
        setPurchases(purchaseList.filter((p) => p.tabId === tabId).sort((a, b) => b.createdAt - a.createdAt));
      } catch (err) {
        if (!controller.signal.aborted && !(err instanceof DOMException && err.name === "AbortError")) setError(err);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [tabId],
  );

  useEffect(() => {
    void load(true);
    return () => controllerRef.current?.abort();
  }, [load]);

  const reload = useCallback(() => load(false), [load]);
  useOnReconnect(() => void load(false));

  // Throttled tab refetch for voucher bursts: leading edge for instant feedback, trailing to catch up.
  const lastFetch = useRef(0);
  const trailing = useRef<number | null>(null);
  const refetchTab = useCallback(() => {
    const run = () => {
      lastFetch.current = Date.now();
      api.tabs
        .get(tabId)
        .then((detail) => setTabState(detail))
        .catch(() => undefined);
    };
    const wait = REFETCH_EVERY_MS - (Date.now() - lastFetch.current);
    if (wait <= 0) run();
    else if (trailing.current === null) {
      trailing.current = window.setTimeout(() => {
        trailing.current = null;
        run();
      }, wait);
    }
  }, [tabId]);
  useEffect(
    () => () => {
      if (trailing.current !== null) window.clearTimeout(trailing.current);
    },
    [tabId],
  );

  const setTab = useCallback((update: (tab: TabDetailDTO) => TabDetailDTO) => setTabState((current) => (current ? update(current) : current)), []);
  const upsertRun = useCallback((run: AgentRunDTO) => {
    runIds.current.add(run.id);
    const queued = pendingSteps.current.get(run.id) ?? [];
    pendingSteps.current.delete(run.id);
    setRuns((list) => {
      const existing = list.find((r) => r.id === run.id);
      // Steps may have streamed in before the create call returned; keep whichever list is longer.
      const merged = existing && existing.steps.length > run.steps.length ? { ...run, steps: existing.steps } : run;
      return upsertById(list, queued.reduce(addStep, merged));
    });
  }, []);
  const upsertPurchase = useCallback((purchase: PurchaseDTO) => setPurchases((list) => upsertById(list, purchase)), []);

  useGatewayEvents(
    [
      "tab.updated",
      "voucher.accepted",
      "voucher.voided",
      "alarm.raised",
      "review.started",
      "review.message",
      "review.finished",
      "settlement.completed",
      "agent.step",
      "agent.finished",
      "purchase.updated",
    ],
    (event) => {
      switch (event.type) {
        case "tab.updated":
          if (event.data.id === tabId) setTab((current) => ({ ...current, ...event.data }));
          return;
        case "voucher.accepted":
        case "voucher.voided":
          if (event.data.tabId === tabId) refetchTab();
          return;
        case "alarm.raised":
          if (event.data.tabId === tabId) setTab((current) => ({ ...current, alarms: upsertById(current.alarms, event.data) }));
          return;
        case "review.started":
        case "review.finished":
          if (event.data.tabId === tabId) setTab((current) => ({ ...current, reviews: upsertReview(current.reviews, event.data) }));
          return;
        case "review.message": {
          const { reviewId, tabId: messageTab, message } = event.data;
          if (messageTab !== tabId) return;
          setTab((current) => {
            const existing = current.reviews.find((r) => r.id === reviewId);
            const base: ReviewDTO = existing ?? {
              id: reviewId,
              tabId,
              status: "running",
              voidedVoucherIds: [],
              transcript: [],
              createdAt: message.at,
            };
            if (base.transcript.some((m) => m.role === message.role && m.at === message.at)) return current;
            return { ...current, reviews: upsertReview(current.reviews, { ...base, transcript: [...base.transcript, message] }) };
          });
          return;
        }
        case "settlement.completed":
          if (event.data.tabId === tabId) setTab((current) => ({ ...current, settlements: upsertById(current.settlements, event.data) }));
          return;
        case "agent.step": {
          const step = event.data;
          if (runIds.current.has(step.runId)) {
            setRuns((list) => list.map((r) => (r.id === step.runId ? addStep(r, step) : r)));
            return;
          }
          if (foreignRuns.current.has(step.runId)) return;
          // A run we haven't seen (started from the CLI, or before the create call returned): queue the step and
          // ask the gateway whose run it is.
          const queue = pendingSteps.current.get(step.runId);
          if (queue) {
            queue.push(step);
            return;
          }
          pendingSteps.current.set(step.runId, [step]);
          api.agentRuns
            .get(step.runId)
            .then((run) => {
              if (run.tabId === tabId) upsertRun(run);
              else {
                foreignRuns.current.add(run.id);
                pendingSteps.current.delete(run.id);
              }
            })
            .catch(() => pendingSteps.current.delete(step.runId));
          return;
        }
        case "agent.finished":
          if (event.data.tabId === tabId) upsertRun(event.data);
          return;
        case "purchase.updated":
          if (event.data.tabId === tabId) upsertPurchase(event.data);
          return;
      }
    },
  );

  return { tab, runs, purchases, error, loading, reload, setTab, upsertRun, upsertPurchase };
}
