/**
 * The hero's proof line: what this gateway has actually cleared (GET /api/metrics/summary). It renders nothing
 * until there is traffic, or when the gateway can't be reached, so the hero never shows zeros.
 */
import type { MetricsSummaryDTO } from "@p402/shared";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatCents, formatCount } from "../../lib/format";

export function LiveProof() {
  const [summary, setSummary] = useState<MetricsSummaryDTO | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    api.metrics.summary(controller.signal).then(setSummary, () => undefined);
    return () => controller.abort();
  }, []);
  if (!summary || summary.accepted === 0) return null;
  const avoided = Math.max(0, summary.naiveFeeCents - summary.paypalFeeCents);
  return (
    <section className="lp-proof" aria-label="Cleared on this gateway">
      <p className="lp-proof-caption">
        <span className="lp-proof-dot" aria-hidden="true" />
        Live from this gateway
      </p>
      <dl>
        <div>
          <dt>Paid calls cleared</dt>
          <dd>{formatCount(summary.accepted)}</dd>
        </div>
        <div>
          <dt>Bad responses never billed</dt>
          <dd>{formatCount(summary.voided)}</dd>
        </div>
        <div>
          <dt>PayPal fees avoided</dt>
          <dd>{formatCents(avoided)}</dd>
        </div>
      </dl>
    </section>
  );
}
