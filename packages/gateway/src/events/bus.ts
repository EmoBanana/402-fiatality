/**
 * Typed in-process event bus for `GatewayEvent` (from @p402/shared). Every emit is appended to
 * `events_log` (except `metrics` snapshots) and delivered synchronously to subscribers; the /ws route
 * subscribes once and broadcasts each event as JSON.
 */
import type { GatewayEvent, GatewayEventOf, GatewayEventType } from "@p402/shared";
import type { Logger } from "pino";
import type { Clock } from "../clock";
import type { Db } from "../db/db";

export type EventListener = (event: GatewayEvent) => void;

export interface EventBus {
  /** Stamp the event with the gateway clock, persist it, notify subscribers and return it. */
  emit<T extends GatewayEventType>(type: T, data: GatewayEventOf<T>["data"]): GatewayEventOf<T>;
  /** Every event. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** One event type. Returns an unsubscribe function. */
  on<T extends GatewayEventType>(type: T, listener: (event: GatewayEventOf<T>) => void): () => void;
}

export interface EventBusOptions {
  db: Db;
  clock: Clock;
  log?: Logger;
  /** Write events to events_log (default true). */
  persist?: boolean;
}

export function createEventBus({ db, clock, log, persist = true }: EventBusOptions): EventBus {
  const listeners = new Set<EventListener>();
  const insert = db.prepare("INSERT INTO events_log (type, tab_id, payload, created_at) VALUES (?, ?, ?, ?)");

  return {
    emit(type, data) {
      const event = { type, at: clock.now(), data } as GatewayEventOf<typeof type>;
      if (persist && type !== "metrics") {
        insert.run(type, eventTabId(event), JSON.stringify(data), event.at);
      }
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (err) {
          log?.error({ err, type }, "event listener failed");
        }
      }
      return event;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    on(type, listener) {
      const wrapped: EventListener = (event) => {
        if (event.type === type) listener(event as GatewayEventOf<typeof type>);
      };
      listeners.add(wrapped);
      return () => listeners.delete(wrapped);
    },
  };
}

/** The tab an event belongs to, for the audit log (null for global events). */
export function eventTabId(event: GatewayEvent): string | null {
  switch (event.type) {
    case "tab.updated":
      return event.data.id;
    case "voucher.accepted":
    case "voucher.voided":
    case "alarm.raised":
    case "review.started":
    case "review.finished":
    case "review.message":
    case "settlement.completed":
    case "agent.finished":
      return event.data.tabId;
    case "purchase.updated":
    case "dispute.updated":
      return event.data.tabId ?? null;
    default:
      return null;
  }
}
