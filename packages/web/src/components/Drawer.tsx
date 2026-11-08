/**
 * Right-hand side panel over a dimmed page. Closes on Esc, overlay click or the close button.
 *   <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Review" width={560}>…</Drawer>
 */
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  actions?: ReactNode;
  width?: number;
  children: ReactNode;
}

export function Drawer({ open, onClose, title, actions, width = 520, children }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <>
      <div className="ui-overlay" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="ui-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ ["--drawer-width" as string]: `${width}px` }}
      >
        <header className="ui-drawer-head">
          <h2 id={titleId} className="ui-drawer-title">
            {title}
          </h2>
          <div style={{ display: "flex", gap: 8 }}>
            {actions}
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose} aria-label="Close">
              Close
            </button>
          </div>
        </header>
        <div className="ui-drawer-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}
