/**
 * Money math. Every internal amount is an integer number of micro-dollars (µUSD):
 * 1 USD = 1,000,000 µUSD and 1 cent = 10,000 µUSD. PayPal only ever sees whole cents.
 */
export type Micros = number;

export const MICROS_PER_DOLLAR = 1_000_000;
export const MICROS_PER_CENT = 10_000;
/** x402 amount precision for USD in this binding (mirrors USDC's 6 decimals). */
export const USD_DECIMALS = 6;

export function assertMicros(n: number): Micros {
  if (!Number.isSafeInteger(n)) throw new Error(`Invalid micros amount: ${n}`);
  return n;
}

/**
 * Parse a dollar amount ("0.005", "$4.31", 0.25) into micros without float drift.
 * Digits beyond the 6th decimal are truncated.
 */
export function dollarsToMicros(input: string | number): Micros {
  const raw = typeof input === "number" ? input.toFixed(USD_DECIMALS) : input.trim().replace(/^\$/, "").replace(/,/g, "");
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(raw);
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) throw new Error(`Invalid dollar amount: ${input}`);
  const sign = match[1] ? -1 : 1;
  const whole = match[2] === "" ? 0 : Number(match[2]);
  const frac = (match[3] ?? "").slice(0, USD_DECIMALS).padEnd(USD_DECIMALS, "0");
  return assertMicros(sign * (whole * MICROS_PER_DOLLAR + Number(frac)));
}

/** Exact decimal string for micros: 5000 -> "0.005", 4310000 -> "4.31", 0 -> "0.00". */
export function microsToDollarString(m: Micros): string {
  assertMicros(m);
  const sign = m < 0 ? "-" : "";
  const abs = Math.abs(m);
  const whole = Math.floor(abs / MICROS_PER_DOLLAR);
  let frac = String(abs % MICROS_PER_DOLLAR).padStart(USD_DECIMALS, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${sign}${whole}.${frac}`;
}

export function centsToMicros(cents: number): Micros {
  return assertMicros(cents * MICROS_PER_CENT);
}

/** Floor micros to whole cents and return the leftover micros (carried forward, never charged). */
export function microsToCentsFloor(m: Micros): { cents: number; remainderMicros: Micros } {
  assertMicros(m);
  if (m <= 0) return { cents: 0, remainderMicros: m };
  const cents = Math.floor(m / MICROS_PER_CENT);
  return { cents, remainderMicros: m - cents * MICROS_PER_CENT };
}

/** PayPal API amount value: 431 -> "4.31". */
export function centsToValue(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Invalid cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** PayPal API amount value to cents: "4.31" -> 431. */
export function valueToCents(value: string): number {
  return Math.round(dollarsToMicros(value) / MICROS_PER_CENT);
}

/** "$4.31", "$0.05", sub-cent amounts keep their precision: "$0.005", "$0.0001". */
export function formatUsd(m: Micros, opts: { sign?: boolean } = {}): string {
  const s = microsToDollarString(m);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [whole, frac = "00"] = body.split(".");
  const wholeWithCommas = Number(whole).toLocaleString("en-US");
  const prefix = neg ? "-" : opts.sign && m > 0 ? "+" : "";
  return `${prefix}$${wholeWithCommas}.${frac}`;
}

export function formatCents(cents: number, opts: { sign?: boolean } = {}): string {
  return formatUsd(centsToMicros(cents), opts);
}

/** Published US PayPal rates (paypal.com/webapps/mpp/merchant-fees, updated Nov 4, 2026). */
export const PAYPAL_US_FEES = {
  /** PayPal Checkout: 3.49% + $0.49 */
  checkout: { basisPoints: 349, fixedCents: 49 },
  /** Micropayments pricing (by application): 4.99% + $0.09 */
  micropayments: { basisPoints: 499, fixedCents: 9 },
  /** US payouts sent through the Payouts API: flat $0.25 per payout */
  payoutApiFlatCents: 25,
} as const;

export type FeeSchedule = "checkout" | "micropayments";

/** PayPal fee for one capture, rounded half-up to the cent. 5000 -> 224 ($2.24 on $50). */
export function captureFeeCents(amountCents: number, schedule: FeeSchedule = "checkout"): number {
  if (amountCents <= 0) return 0;
  const { basisPoints, fixedCents } = PAYPAL_US_FEES[schedule];
  return Math.floor((amountCents * basisPoints + 5_000) / 10_000) + fixedCents;
}

/**
 * What PayPal would charge if every call were its own payment (which PayPal can't
 * process below one cent anyway). Used for the "without batching" comparison.
 */
export function naiveFeeCents(callCount: number, totalMicros: Micros, schedule: FeeSchedule = "checkout"): number {
  if (callCount <= 0) return 0;
  const { basisPoints, fixedCents } = PAYPAL_US_FEES[schedule];
  const pctMicros = Math.floor((totalMicros * basisPoints + 5_000) / 10_000);
  return callCount * fixedCents + Math.round(pctMicros / MICROS_PER_CENT);
}

/** Effective fee rate in percent, e.g. 4.47. */
export function effectiveRatePct(feeCents: number, amountCents: number): number {
  if (amountCents <= 0) return 0;
  return Math.round((feeCents / amountCents) * 10_000) / 100;
}

/**
 * Split an integer total across keys in proportion to weights (largest remainder method).
 * The parts always sum exactly to `total`. Ties break by key order for determinism.
 */
export function allocateProRata(total: number, weights: Record<string, number>): Record<string, number> {
  if (!Number.isSafeInteger(total)) throw new Error(`Invalid total: ${total}`);
  const keys = Object.keys(weights).sort();
  const result: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
  const weightSum = keys.reduce((s, k) => s + Math.max(0, weights[k] ?? 0), 0);
  if (keys.length === 0 || weightSum <= 0 || total === 0) return result;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const shares = keys.map((k) => {
    const exact = (abs * Math.max(0, weights[k] ?? 0)) / weightSum;
    const floor = Math.floor(exact);
    return { k, floor, rem: exact - floor };
  });
  let leftover = abs - shares.reduce((s, x) => s + x.floor, 0);
  shares
    .slice()
    .sort((a, b) => b.rem - a.rem || (a.k < b.k ? -1 : 1))
    .forEach((x) => {
      if (leftover > 0) {
        x.floor += 1;
        leftover -= 1;
      }
    });
  for (const x of shares) result[x.k] = sign * x.floor;
  return result;
}
