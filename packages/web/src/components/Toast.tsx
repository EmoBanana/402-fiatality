/**
 * Toasts. <ToastProvider> is mounted once in AppShell; anywhere below it:
 *   const toast = useToast();
 *   toast({ title: "Tab settled", description: "One PayPal charge of $49.87", tone: "success" });
 * Tones: info (default) | success | warning | danger. Auto-dismiss after `durationMs` (default 5 s; 0 = sticky).
 */
import { createContext, type ReactNode, useCallback, useContext, useMemo, useRef, useState } from "react";

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

  const dismiss = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const show = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { ...options, id }]);
      const duration = options.durationMs ?? 5_000;
      if (duration > 0) window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );
  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="ui-toasts" role="region" aria-label="Notifications" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="ui-toast" data-tone={t.tone ?? "info"} role={t.tone === "danger" ? "alert" : "status"}>
            <div>
              <p className="ui-toast-title">{t.title}</p>
              {t.description != null ? <p className="ui-toast-description">{t.description}</p> : null}
            </div>
            <button type="button" className="ui-toast-close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
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
