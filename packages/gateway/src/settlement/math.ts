/**
 * Settlement math (SPEC §6.4), pure so it can be tested exhaustively.
 *
 * - billable = Σ accepted voucher prices + the carry-in from the company's previous tab.
 * - The charge is billable floored to whole cents; the sub-cent remainder carries into the next tab.
 * - Nothing is charged when no seller earned anything (the whole billable carries forward).
 * - Line `grossMicros` is each seller's pro-rata share of what was actually charged (its voucher total
 *   adjusted by its share of the sub-cent carry in/out), so the ledger invariant holds exactly:
 *     Σ net + Σ feeShare = Σ gross = chargedCents × 10 000, with net = gross − feeShare.
 * - The PayPal fee is split pro rata by voucher gross, in micros (largest remainder, ties by seller id).
 */
import { allocateProRata, captureFeeCents, MICROS_PER_CENT, microsToCentsFloor, naiveFeeCents, type Micros } from "@p402/shared";

export interface SellerGross {
  sellerId: string;
  /** Σ price of this seller's accepted vouchers in the settlement. */
  grossMicros: Micros;
  calls: number;
}

export interface SettlementPlan {
  /** Σ voucher gross + carry-in. */
  billableMicros: Micros;
  vouchersMicros: Micros;
  carryInMicros: Micros;
  chargedCents: number;
  carryOutMicros: Micros;
  callCount: number;
  /** Fees if each call had been its own PayPal payment. */
  naiveFeeCents: number;
}

export interface PlannedLine extends SellerGross {
  feeShareMicros: Micros;
  netMicros: Micros;
}

export function planSettlement(sellers: SellerGross[], carryInMicros: Micros): SettlementPlan {
  const vouchersMicros = sellers.reduce((sum, s) => sum + s.grossMicros, 0);
  const callCount = sellers.reduce((sum, s) => sum + s.calls, 0);
  const billableMicros = vouchersMicros + carryInMicros;
  const floored = microsToCentsFloor(billableMicros);
  const chargedCents = vouchersMicros > 0 ? floored.cents : 0;
  return {
    billableMicros,
    vouchersMicros,
    carryInMicros,
    chargedCents,
    carryOutMicros: billableMicros - chargedCents * MICROS_PER_CENT,
    callCount,
    naiveFeeCents: naiveFeeCents(callCount, vouchersMicros),
  };
}

/** Per-seller lines for a charge of `chargedCents` with PayPal fee `feeCents`. Sorted by seller id. */
export function allocateLines(sellers: SellerGross[], chargedCents: number, feeCents: number): PlannedLine[] {
  const weights = Object.fromEntries(sellers.map((s) => [s.sellerId, s.grossMicros]));
  const gross = allocateProRata(chargedCents * MICROS_PER_CENT, weights);
  const fees = allocateProRata(feeCents * MICROS_PER_CENT, weights);
  return [...sellers]
    .sort((a, b) => (a.sellerId < b.sellerId ? -1 : a.sellerId > b.sellerId ? 1 : 0))
    .map((s) => {
      const grossMicros = gross[s.sellerId] ?? 0;
      const feeShareMicros = fees[s.sellerId] ?? 0;
      return { sellerId: s.sellerId, calls: s.calls, grossMicros, feeShareMicros, netMicros: grossMicros - feeShareMicros };
    });
}

/** The fee PayPal will most likely charge (published US Checkout rate), for previews and fallbacks. */
export function estimatedFeeCents(chargedCents: number): number {
  return captureFeeCents(chargedCents);
}

/** "Agent API usage, 1,204 calls across 3 sellers" (PayPal note_to_payer, ≤ 255 chars). */
export function noteToPayer(callCount: number, sellerCount: number): string {
  const calls = `${callCount.toLocaleString("en-US")} ${callCount === 1 ? "call" : "calls"}`;
  const sellers = `${sellerCount} ${sellerCount === 1 ? "seller" : "sellers"}`;
  return `Agent API usage, ${calls} across ${sellers}`;
}
