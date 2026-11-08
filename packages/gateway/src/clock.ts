/**
 * Gateway time. `now()` = real time + an offset persisted in kv, so the demo can fast-forward through a
 * tab's hold, reauthorization and charge. The offset only exists in demo mode; otherwise time is real.
 * Use `ctx.clock.now()` for everything stored or compared (never Date.now()).
 */
import type { ClockDTO } from "@p402/shared";
import { type Db, kvGet, kvSet } from "./db/db";

export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** Largest single fast-forward step. */
export const MAX_ADVANCE_MS = 60 * DAY_MS;

const OFFSET_KEY = "clock.offset_ms";

export interface Clock {
  /** Epoch ms including the demo offset. */
  now(): number;
  offsetMs(): number;
  /** Demo only: move time forward by `ms` (1 ms .. 60 days). The caller then runs settlement.tick(). */
  advance(ms: number): ClockDTO;
  /** Demo only: back to real time. */
  reset(): ClockDTO;
  dto(): ClockDTO;
}

export class ClockLockedError extends Error {
  override name = "ClockLockedError";
  constructor() {
    super("The clock can only be changed when DEMO_MODE=1.");
  }
}

export function createClock(db: Db, opts: { demo: boolean; realNow?: () => number }): Clock {
  const realNow = opts.realNow ?? Date.now;
  let offset = opts.demo ? Number(kvGet(db, OFFSET_KEY) ?? 0) || 0 : 0;

  const setOffset = (value: number) => {
    offset = value;
    kvSet(db, OFFSET_KEY, String(value));
  };
  const dto = (): ClockDTO => ({ now: realNow() + offset, offsetMs: offset });

  return {
    now: () => realNow() + offset,
    offsetMs: () => offset,
    advance(ms) {
      if (!opts.demo) throw new ClockLockedError();
      if (!Number.isSafeInteger(ms) || ms <= 0 || ms > MAX_ADVANCE_MS) {
        throw new RangeError(`Clock advance must be 1..${MAX_ADVANCE_MS} ms, got ${ms}`);
      }
      setOffset(offset + ms);
      return dto();
    },
    reset() {
      if (!opts.demo) throw new ClockLockedError();
      setOffset(0);
      return dto();
    },
    dto,
  };
}

/** Start of the UTC calendar day containing `ms` (policy daily caps are per UTC day). */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
