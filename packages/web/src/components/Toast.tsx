/**
 * Toasts. <ToastProvider> is mounted once in AppShell; anywhere below it:
 *   const toast = useToast();
 *   toast({ title: "Tab settled", description: "One PayPal charge of $49.87", tone: "success" });
 * Tones: info (default) | success | warning | danger. Auto-dismiss after `durationMs` (default 5 s, 8 s for
 * danger; 0 = sticky). At most four stay on screen.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  tone?: "info" | "success" | "warning" | "danger";
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<((options: ToastOptions) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { ...options, id }]);
      const duration = options.durationMs ?? (options.tone === "danger" ? 8_000 : 5_000);
      if (duration > 0) timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="ui-toast" data-tone={t.tone ?? "info"} role={t.tone === "danger" ? "alert" : "status"}>
            <span className="ui-toast-mark" aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <p className="ui-toast-title">{t.title}</p>
              {t.description != null ? <p className="ui-toast-description">{t.description}</p> : null}
            </div>
            <button type="button" className="ui-toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): (options: ToastOptions) => void {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast() must be used inside <ToastProvider>");
  return toast;
}
