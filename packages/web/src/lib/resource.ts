/**
 * Load data with loading / error state. Aborts on unmount and when `deps` change.
 *
 *   const sellers = useResource((signal) => api.sellers.list(signal), []);
 *   if (sellers.error) return <ErrorState error={sellers.error} onRetry={sellers.reload} />;
 *   sellers.setData((list) => upsert(list, event.data));   // apply live events locally
 *
 * `reload()` keeps the current data while it refetches (`loading` is true, `data` stays). Changing `deps`
 * clears it, so a different tab never flashes the previous tab's numbers. Pass `enabled: false` to wait.
 */
import { type DependencyList, type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  /** True during the first load and during reloads. */
  loading: boolean;
  /** Refetch, keeping the current data visible. Returns when done. */
  reload: () => Promise<void>;
  setData: Dispatch<SetStateAction<T | undefined>>;
}

export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  options: { enabled?: boolean } = {},
): Resource<T> {
  const enabled = options.enabled ?? true;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(enabled);
  const loadRef = useRef(load);
  loadRef.current = load;
  const controllerRef = useRef<AbortController | null>(null);

  const run = useCallback(async (keep: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(null);
    if (!keep) setData(undefined);
    try {
      const value = await loadRef.current(controller.signal);
      if (!controller.signal.aborted) setData(value);
    } catch (err) {
      if (!controller.signal.aborted && !(err instanceof DOMException && err.name === "AbortError")) setError(err);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    void run(false);
    return () => controllerRef.current?.abort();
  }, [enabled, run, ...deps]);

  const reload = useCallback(() => run(true), [run]);
  return { data, error, loading, reload, setData };
}

/** Insert or replace by id, newest first unless `append`. */
export function upsertById<T extends { id: string }>(list: T[] | undefined, item: T, append = false): T[] {
  const current = list ?? [];
  const index = current.findIndex((x) => x.id === item.id);
  if (index === -1) return append ? [...current, item] : [item, ...current];
  const next = current.slice();
  next[index] = item;
  return next;
}
