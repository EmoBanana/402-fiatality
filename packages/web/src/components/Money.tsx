/**
 * Money in monospace tabular figures. Takes micros (sub-cent precision kept: $0.005) or cents.
 *   <Money micros={5_000} />          -> $0.005
 *   <Money cents={224} />             -> $2.24
 *   <Money micros={-250_000} sign />  -> -$0.25 (sign adds "+" to positives)
 *   <Money micros={10_000} padTo={3} /> -> $0.01 plus one invisible digit, so a column of
 *                                        $0.005 / $0.01 / $0.002 lines up on the decimal point
 * Digits beyond the cent render muted so sub-cent IOUs read at a glance.
 */
import { formatUsd, MICROS_PER_CENT } from "@p402/shared";

export interface MoneyProps {
  micros?: number;
  cents?: number;
  sign?: boolean;
  /** Mute the sub-cent digits (default true). */
  splitSubCent?: boolean;
  /** Pad the fraction with invisible digits to this many places (decimal alignment in columns). */
  padTo?: number;
  className?: string;
  title?: string;
}

export function Money({ micros, cents, sign = false, splitSubCent = true, padTo, className, title }: MoneyProps) {
  const value = micros ?? (cents ?? 0) * MICROS_PER_CENT;
  const text = formatUsd(value, { sign });
  const dot = text.indexOf(".");
  const fraction = dot < 0 ? 0 : text.length - dot - 1;
  const pad = padTo && padTo > fraction ? (
    <span className="ui-money-pad" aria-hidden="true">
      {"0".repeat(padTo - fraction)}
    </span>
  ) : null;
  const classes = ["ui-money", className].filter(Boolean).join(" ");
  if (!splitSubCent || dot < 0 || fraction <= 2) {
    return (
      <span className={classes} title={title}>
        {text}
        {pad}
      </span>
    );
  }
  return (
    <span className={classes} title={title ?? text}>
      {text.slice(0, dot + 3)}
      <span className="ui-money-sub">{text.slice(dot + 3)}</span>
      {pad}
    </span>
  );
}
