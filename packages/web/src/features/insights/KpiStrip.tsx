/** A row of headline numbers above a section's charts. Takes <Stat/> children; wraps on narrow screens. */
import type { ReactNode } from "react";

export function KpiStrip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ins-kpis" role="group" aria-label={label}>
      {children}
    </div>
  );
}
