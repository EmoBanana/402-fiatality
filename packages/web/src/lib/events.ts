/**
 * Live gateway events over one shared WebSocket (`/ws`), with automatic reconnect.
 *
 *   useGatewayEvents(["voucher.accepted", "voucher.voided"], (e) => grid.applyTransactionAsync({ add: [e.data] }));
 *   const status = useGatewayStatus();                  // "connecting" | "open" | "closed"
 *   const metrics = useLatestEvent("metrics")?.data;    // sent on connect, then at most every 1 s
 *   useOnReconnect(() => refetch());                    // events missed while offline are not replayed
 *   const off = subscribe("tab.updated", handler);      // outside React (AG Grid callbacks, etc.)
 *
 * The socket opens on the first subscription and stays open for the page's lifetime.
 */
import type { GatewayEvent, GatewayEventOf, GatewayEventType } from "@p402/shared";
import { useEffect, useRef, useSyncExternalStore } from "react";

export type ConnectionStatus = "connecting" | "open" | "closed";

type AnyHandler = (event: GatewayEvent) => void;
type Types<T extends GatewayEventType> = T | readonly T[] | "*";

class GatewaySocket {
  private socket: WebSocket | null = null;
  private handlers = new Set<AnyHandler>();
  private watchers = new Set<() => void>();
  private latest = new Map<GatewayEventType, GatewayEvent>();
  private attempt = 0;
  private started = false;
  status: ConnectionStatus = "closed";
  /** Increments on every successful (re)connect. */
  connections = 0;

  subscribe(handler: AnyHandler): () => void {
    this.handlers.add(handler);
    this.start();
    return () => this.handlers.delete(handler);
  }

  /** For useSyncExternalStore: fires on status changes and on every event. */
  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    this.start();
    return () => this.watchers.delete(onChange);
  }

  latestOf<T extends GatewayEventType>(type: T): GatewayEventOf<T> | null {
    return (this.latest.get(type) as GatewayEventOf<T> | undefined) ?? null;
  }

  private start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.connect();
  }

  private connect() {
    const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
    this.setStatus("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.connections += 1;
      this.setStatus("open");
    };
    socket.onmessage = (message) => {
      let event: GatewayEvent;
      try {
        event = JSON.parse(String(message.data)) as GatewayEvent;
      } catch {
        return;
      }
      if (!event || typeof event.type !== "string") return;
      this.latest.set(event.type, event);
      for (const handler of this.handlers) {
        try {
          handler(event);
        } catch (err) {
          console.error("gateway event handler failed", err);
        }
      }
      this.notify();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus("closed");
      const delay = Math.min(10_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt += 1;
      setTimeout(() => this.connect(), delay);
    };
    socket.onerror = () => socket.close();
  }

  private setStatus(status: ConnectionStatus) {
    this.status = status;
    this.notify();
  }

  private notify() {
    for (const watcher of this.watchers) watcher();
  }
}

const gatewaySocket = new GatewaySocket();

function matches<T extends GatewayEventType>(types: Types<T>, type: GatewayEventType): type is T {
  if (types === "*") return true;
  return typeof types === "string" ? types === type : (types as readonly GatewayEventType[]).includes(type);
}

/** Typed subscription outside React. Returns an unsubscribe function. */
export function subscribe<T extends GatewayEventType>(types: Types<T>, handler: (event: GatewayEventOf<T>) => void): () => void {
  return gatewaySocket.subscribe((event) => {
    if (matches(types, event.type)) handler(event as GatewayEventOf<T>);
  });
}

/** Subscribe for the component's lifetime. The handler may change between renders without resubscribing. */
export function useGatewayEvents<T extends GatewayEventType>(types: Types<T>, handler: (event: GatewayEventOf<T>) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = typeof types === "string" ? types : [...types].sort().join(",");
  useEffect(() => {
    const list: Types<T> = key === "*" ? "*" : (key.split(",") as T[]);
    return subscribe(list, (event) => handlerRef.current(event));
  }, [key]);
}

export function useGatewayStatus(): ConnectionStatus {
  return useSyncExternalStore(
    (onChange) => gatewaySocket.watch(onChange),
    () => gatewaySocket.status,
    () => "closed",
  );
}

/** The most recent event of a type (e.g. "metrics", "clock.advanced"), or null before the first one. */
export function useLatestEvent<T extends GatewayEventType>(type: T): GatewayEventOf<T> | null {
  return useSyncExternalStore(
    (onChange) => gatewaySocket.watch(onChange),
    () => gatewaySocket.latestOf(type),
    () => null,
  );
}

/** Runs `callback` after each reconnect (not the first connect), to refetch state missed while offline. */
export function useOnReconnect(callback: () => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const connections = useSyncExternalStore(
    (onChange) => gatewaySocket.watch(onChange),
    () => gatewaySocket.connections,
    () => 0,
  );
  const seen = useRef(connections);
  useEffect(() => {
    if (connections > 1 && connections !== seen.current) callbackRef.current();
    seen.current = connections;
  }, [connections]);
}
