/**
 * Horizontal gauge, e.g. spend against the hold. `marks` draw thin ticks (close-at, warn threshold).
 *   <Meter label="Spent of hold" value={billable} max={hold} valueLabel={<Money micros={billable} />}
 *     marks={[{ at: closeAt, label: "Charges at $50" }]} tone="accent" />
 * Tones: accent (default) | success | warning | danger. Exposed to assistive tech as role="meter".
 */
import type { ReactNode } from "react";

export interface MeterProps {
  value: number;
  max: number;
  label?: ReactNode;
  /** Right-hand text above the bar (defaults to the percentage). */
  valueLabel?: ReactNode;
  /** Plain-text description for screen readers, e.g. "$0.19 of $50.00". */
  ariaValueText?: string;
  tone?: "accent" | "success" | "warning" | "danger";
  marks?: Array<{ at: number; label: string }>;
  className?: string;
}

export function Meter({ value, max, label, valueLabel, ariaValueText, tone = "accent", marks = [], className }: MeterProps) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const pct = Math.round(ratio * 1000) / 10;
  return (
    <div className={["ui-meter", className].filter(Boolean).join(" ")} data-tone={tone}>
      {label != null || valueLabel != null ? (
        <div className="ui-meter-head">
          <span>{label}</span>
          <span className="num">{valueLabel ?? `${pct}%`}</span>
        </div>
      ) : null}
      <div
        className="ui-meter-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Math.min(value, max)}
        aria-valuetext={ariaValueText ?? `${pct}%`}
        aria-label={typeof label === "string" ? label : undefined}
      >
        <span className="ui-meter-fill" style={{ width: `${ratio * 100}%`, minWidth: value > 0 ? 3 : 0 }} />
        {marks
          .filter((m) => max > 0 && m.at > 0 && m.at < max)
          .map((m) => (
            <span key={m.label} className="ui-meter-mark" style={{ left: `${(m.at / max) * 100}%` }} title={m.label} />
          ))}
      </div>
    </div>
  );
}
