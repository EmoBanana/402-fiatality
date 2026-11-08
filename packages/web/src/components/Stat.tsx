/**
 * A labeled number. `value` is usually <Money/> or a formatted count; tone colors the value; size "lg" for
 * the one figure that matters most on a card.
 *   <Stat label="Billable" value={<Money micros={m.billableMicros} />} hint="312 calls" />
 */
import type { ReactNode } from "react";

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "accent" | "success" | "danger";
  size?: "md" | "lg";
  className?: string;
}

export function Stat({ label, value, hint, tone = "default", size = "md", className }: StatProps) {
  return (
    <div className={["ui-stat", size === "lg" && "ui-stat--lg", className].filter(Boolean).join(" ")} data-tone={tone}>
      <span className="ui-stat-label">{label}</span>
      <span className="ui-stat-value">{value}</span>
      {hint != null ? <span className="ui-stat-hint">{hint}</span> : null}
    </div>
  );
}
