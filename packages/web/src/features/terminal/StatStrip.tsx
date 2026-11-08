/**
 * The terminal's KPI row: what cleared, what was voided, and what PayPal earned versus what per-call charges
 * would have cost. Metrics arrive at most once a second (the `metrics` event); payout fees come from payouts.
 */
import { effectiveRatePct } from "@p402/shared";
import { Money, Stat } from "../../components";
import { formatCount, formatPct, formatUsd } from "../../lib/format";
import { useTerminal } from "./store";

const DASH = <span className="tx-dash">—</span>;

export function StatStrip() {
  const metrics = useTerminal((s) => s.metrics);
  const payouts = useTerminal((s) => s.payouts);

  const live = payouts.filter((p) => p.status !== "failed");
  const payoutFeeCents = live.reduce((sum, p) => sum + p.feeCents, 0);
  const paidSellers = new Set(live.flatMap((p) => p.items.filter((i) => i.status !== "failed").map((i) => i.sellerId))).size;

  const m = metrics;
  const settledCents = m ? Math.floor(m.settledMicros / 10_000) : 0;
  const feeRate = m && settledCents > 0 ? effectiveRatePct(m.paypalFeeCents, settledCents) : null;
  const voidShare = m && m.calls > 0 ? (m.voided / m.calls) * 100 : null;
  const multiple = m && m.paypalFeeCents > 0 ? m.naiveFeeCents / m.paypalFeeCents : null;

  return (
    <section className="tx-stats" aria-label="Ledger totals">
      <Stat label="Calls" value={m ? formatCount(m.calls) : DASH} hint={m ? `${formatCount(m.accepted)} accepted` : "Paid API calls"} />
      <Stat
        label="Billable"
        value={m ? <Money micros={m.billableMicros} /> : DASH}
        hint={m ? `${formatUsd(m.settledMicros)} settled` : "Accepted IOUs"}
      />
      <Stat
        label="Voided"
        tone={m && m.voided > 0 ? "danger" : "default"}
        value={m ? formatCount(m.voided) : DASH}
        hint={m ? `${formatUsd(m.voidedMicros)} not charged${voidShare != null ? ` · ${formatPct(voidShare, 1)}` : ""}` : "Bad responses, never billed"}
      />
      <Stat
        label="PayPal fee"
        value={m ? <Money cents={m.paypalFeeCents} /> : DASH}
        hint={feeRate != null ? `${formatPct(feeRate)} of charges` : "One capture per tab"}
      />
      <Stat
        label="Fee without batching"
        value={m ? <Money cents={m.naiveFeeCents} /> : DASH}
        hint={multiple != null && multiple >= 1.05 ? `${multiple.toFixed(multiple >= 10 ? 0 : 1)}× the batched fee` : "If every call were a payment"}
      />
      <Stat
        label="PayPal revenue"
        tone="accent"
        value={m ? <Money cents={m.paypalFeeCents + payoutFeeCents} /> : DASH}
        hint={payoutFeeCents > 0 ? `Incl. ${formatUsd(payoutFeeCents * 10_000)} payout fees` : "Capture fees + 25¢ a payout"}
      />
      <Stat
        label="Sellers paid"
        value={m ? <Money micros={m.sellersPaidMicros} /> : DASH}
        hint={live.length > 0 ? `${formatCount(live.length)} payout${live.length === 1 ? "" : "s"} · ${paidSellers} seller${paidSellers === 1 ? "" : "s"}` : "Weekly PayPal payouts"}
      />
    </section>
  );
}
