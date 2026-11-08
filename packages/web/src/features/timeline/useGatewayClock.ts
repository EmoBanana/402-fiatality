/**
 * The gateway's clock, which can run ahead of real time in demo mode (POST /api/clock/advance).
 *
 *   const clock = useGatewayClock();        // clock.now() follows the gateway, ticking locally
 *   await clock.advance(86_400_000);        // demo only: +1 day, then the gateway runs its scheduler
 *
 * The offset comes from GET /api/clock and every `clock.advanced` event. When the clock route is
 * unavailable the hook falls back to the browser's clock (`available: false`).
 */
import type { ClockDTO } from "@p402/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { useGatewayEvents, useOnReconnect } from "../../lib/events";

export interface GatewayClock {
  /** Gateway time in epoch ms, at the moment of the last tick. */
  now: number;
  /** Gateway minus browser time; > 0 after fast-forwarding. */
  offsetMs: number;
  /** False until the gateway answered GET /api/clock (the browser clock is used meanwhile). */
  available: boolean;
  /** Demo only. Resolves with the new clock; throws ApiError. */
  advance: (ms: number) => Promise<ClockDTO>;
  refresh: () => void;
}

export function useGatewayClock(tickMs = 15_000): GatewayClock {
  const [offsetMs, setOffsetMs] = useState(0);
  const [available, setAvailable] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const mounted = useRef(true);

  const apply = useCallback((dto: ClockDTO) => {
    // Derive the offset from `now` rather than trusting `offsetMs`, so browser/gateway skew cancels out.
    setOffsetMs(dto.now - Date.now());
    setAvailable(true);
    setTick(Date.now());
  }, []);

  const refresh = useCallback(() => {
    api.clock
      .get()
      .then((dto) => {
        if (mounted.current) apply(dto);
      })
      .catch(() => {
        if (mounted.current) setAvailable(false);
      });
  }, [apply]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = window.setInterval(() => setTick(Date.now()), tickMs);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh, tickMs]);

  useGatewayEvents("clock.advanced", (event) => apply(event.data));
  useOnReconnect(refresh);

  const advance = useCallback(
    async (ms: number) => {
      const dto = await api.clock.advance(ms);
      apply(dto);
      return dto;
    },
    [apply],
  );

  return { now: tick + offsetMs, offsetMs, available, advance, refresh };
}
