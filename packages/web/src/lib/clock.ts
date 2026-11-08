/**
 * The gateway's clock. In demo mode it can be fast-forwarded (POST /api/clock/advance), so relative times
 * such as "reauthorizes in 3 days" must be measured from the gateway's now, never from Date.now().
 *
 *   const now = useGatewayNow();             // re-renders every 15 s and whenever the clock moves
 *   const { demoOffsetMs } = useGatewayClock();
 *   formatRelative(tab.closeAt, now)
 *   gatewayNow()                             // outside React
 *
 * Synced from GET /api/clock on first use and from every `clock.advanced` event. When the gateway is
 * unreachable the local clock is used.
 */
import type { ClockDTO } from "@p402/shared";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import { subscribe } from "./events";

interface ClockState {
  /** gateway now - local now at the last sync. */
  skewMs: number;
  /** The demo fast-forward offset reported by the gateway. */
  demoOffsetMs: number;
  synced: boolean;
}

let state: ClockState = { skewMs: 0, demoOffsetMs: 0, synced: false };
const listeners = new Set<() => void>();
let started = false;

function apply(clock: ClockDTO) {
  state = { skewMs: clock.now - Date.now(), demoOffsetMs: clock.offsetMs, synced: true };
  for (const listener of listeners) listener();
}

function start() {
  if (started || typeof window === "undefined") return;
  started = true;
  api.clock
    .get()
    .then(apply)
    .catch(() => undefined);
  subscribe("clock.advanced", (event) => apply(event.data));
}

function subscribeClock(listener: () => void): () => void {
  start();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Gateway time in epoch ms. */
export function gatewayNow(): number {
  start();
  return Date.now() + state.skewMs;
}

export function useGatewayClock(): ClockState & { now: number } {
  const snapshot = useSyncExternalStore(subscribeClock, () => state, () => state);
  return { ...snapshot, now: Date.now() + snapshot.skewMs };
}

/** Gateway now, refreshed every `intervalMs` and immediately when the demo clock moves. */
export function useGatewayNow(intervalMs = 15_000): number {
  const { skewMs } = useSyncExternalStore(subscribeClock, () => state, () => state);
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  // `tick` only drives re-renders; read the time fresh so a skew change shows at once.
  void tick;
  return Date.now() + skewMs;
}
