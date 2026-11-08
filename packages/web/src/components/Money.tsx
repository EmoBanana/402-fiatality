/**
 * Money in monospace tabular figures. Takes micros (sub-cent precision kept: $0.005) or cents.
 *   <Money micros={5_000} />          -> $0.005
 *   <Money cents={224} />             -> $2.24
 *   <Money micros={-250_000} sign />  -> -$0.25 (sign adds "+" to positives)
 * Digits beyond the cent render muted so sub-cent IOUs read at a glance.
 */
import { formatUsd, MICROS_PER_CENT } from "@p402/shared";

export interface MoneyProps {
  micros?: number;
  cents?: number;
  sign?: boolean;
  /** Mute the sub-cent digits (default true). */
  splitSubCent?: boolean;
  className?: string;
  title?: string;
}

export function Money({ micros, cents, sign = false, splitSubCent = true, className, title }: MoneyProps) {
  const value = micros ?? (cents ?? 0) * MICROS_PER_CENT;
  const text = formatUsd(value, { sign });
  const dot = text.indexOf(".");
  const classes = ["ui-money", className].filter(Boolean).join(" ");
  if (!splitSubCent || dot < 0 || text.length - dot - 1 <= 2) {
    return (
      <span className={classes} title={title}>
        {text}
      </span>
    );
  }
  return (
    <span className={classes} title={title ?? text}>
      {text.slice(0, dot + 3)}
      <span className="ui-money-sub">{text.slice(dot + 3)}</span>
    </span>
  );
}
