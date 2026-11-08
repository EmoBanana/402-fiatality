/**
 * Gateway config (GET /api/config) and health (GET /api/health), each fetched once per page load and shared
 * by every component that asks.
 *
 *   const { data: config, error, loading, retry } = useGatewayConfig();
 *   const health = useGatewayHealth().data;       // llm.reachable tells whether Gemma answers
 *   const cfg = await getGatewayConfig();         // outside React (throws ApiError)
 *
 * A failed fetch is not cached: `retry()` (or the next getGatewayConfig()) asks again.
 */
import type { ConfigDTO, HealthDTO } from "@p402/shared";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";

export interface SharedState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
}

class SharedResource<T> {
  private state: SharedState<T> = { data: null, error: null, loading: false };
  private promise: Promise<T> | null = null;
  private listeners = new Set<() => void>();

  constructor(private readonly load: () => Promise<T>) {}

  get = (): SharedState<T> => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  fetch(force = false): Promise<T> {
    if (this.promise && !force) return this.promise;
    this.set({ data: this.state.data, error: null, loading: true });
    const promise = this.load().then(
      (data) => {
        this.set({ data, error: null, loading: false });
        return data;
      },
      (error: unknown) => {
        if (this.promise === promise) this.promise = null;
        this.set({ data: this.state.data, error, loading: false });
        throw error;
      },
    );
    this.promise = promise;
    return promise;
  }

  private set(next: SharedState<T>) {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

const configResource = new SharedResource<ConfigDTO>(() => api.config());
const healthResource = new SharedResource<HealthDTO>(() => api.health());

function useShared<T>(resource: SharedResource<T>): SharedState<T> & { retry: () => void } {
  const state = useSyncExternalStore(resource.subscribe, resource.get, resource.get);
  useEffect(() => {
    resource.fetch().catch(() => undefined);
  }, [resource]);
  const retry = useCallback(() => {
    resource.fetch(true).catch(() => undefined);
  }, [resource]);
  return { ...state, retry };
}

export function useGatewayConfig(): SharedState<ConfigDTO> & { retry: () => void } {
  return useShared(configResource);
}

export function useGatewayHealth(): SharedState<HealthDTO> & { retry: () => void } {
  return useShared(healthResource);
}

/** The config, fetching it if needed. Throws ApiError when the gateway is unreachable. */
export function getGatewayConfig(): Promise<ConfigDTO> {
  return configResource.fetch();
}
