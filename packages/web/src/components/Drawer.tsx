/**
 * Right-hand side panel over a dimmed page. Closes on Esc, overlay click or the close button; keeps Tab
 * focus inside while open and returns focus to where it was.
 *   <Drawer open={Boolean(selected)} onClose={() => setSelected(null)} title="Review" width={560}
 *     footer={<Button variant="primary" type="submit" form="seller-form">List API</Button>}>…</Drawer>
 */
import { type ReactNode, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  actions?: ReactNode;
  /** Sticky bar under the body (form buttons). */
  footer?: ReactNode;
  width?: number;
  children: ReactNode;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Drawer({ open, onClose, title, actions, footer, width = 520, children }: DrawerProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open]);

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
            <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose}>
              Close
            </button>
          </div>
        </header>
        <div className="ui-drawer-body">{children}</div>
        {footer != null ? <footer className="ui-drawer-foot">{footer}</footer> : null}
      </div>
    </>,
    document.body,
  );
}
