/**
 * A labeled number. `value` is usually <Money/> or a formatted count; tone colors the value.
 *   <Stat label="Billable" value={<Money micros={m.billableMicros} />} hint="312 calls" />
 */
import type { ReactNode } from "react";

export interface StatProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "default" | "accent" | "success" | "danger";
  className?: string;
}

export function Stat({ label, value, hint, tone = "default", className }: StatProps) {
  return (
    <div className={["ui-stat", className].filter(Boolean).join(" ")} data-tone={tone}>
      <span className="ui-stat-label">{label}</span>
      <span className="ui-stat-value">{value}</span>
      {hint != null ? <span className="ui-stat-hint">{hint}</span> : null}
    </div>
  );
}
