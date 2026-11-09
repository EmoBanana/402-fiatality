/**
 * One listed API: what each endpoint costs, what the seller is owed and has been paid, how often calls were
 * voided, and the rules that decide it. Pause/resume takes the listing off the paywall.
 */
import type { SellerDTO } from "@p402/shared";
import { useState } from "react";
import { SellerStatusBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/CopyButton";
import { describeError } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { formatCents, formatCount, formatPct } from "../../lib/format";

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function voidRulesText(seller: SellerDTO): string {
  const r = seller.voidRules;
  const parts = [
    r.on5xx && "seller errors",
    r.on4xx && "rejected requests",
    r.requireJson && "malformed JSON",
    !r.emptyIsBillable && (r.emptyResultPaths.length ? `empty ${r.emptyResultPaths.join(", ")}` : "empty results"),
    `answers slower than ${r.timeoutMs >= 1000 ? `${r.timeoutMs / 1000} s` : `${r.timeoutMs} ms`}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function SellerCard({ seller, thresholdCents, onUpdate }: { seller: SellerDTO; thresholdCents: number; onUpdate: (seller: SellerDTO) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { calls, voids } = seller.stats;
  const voidRate = calls ? (voids / calls) * 100 : 0;
  const due = seller.balanceMicros >= thresholdCents * 10_000;

  async function toggle() {
    setBusy(true);
    const status = seller.status === "active" ? "paused" : "active";
    try {
      onUpdate(await api.sellers.update(seller.id, { status }));
      toast({ tone: "success", title: status === "paused" ? `${seller.name} paused` : `${seller.name} is live again` });
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't change the listing") });
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="ui-card sl-card" data-status={seller.status} aria-labelledby={`sl-${seller.id}`}>
      <header className="sl-card-head">
        <div style={{ minWidth: 0 }}>
          <h3 id={`sl-${seller.id}`}>{seller.name}</h3>
          <p className="sl-card-sub">
            <span className="mono">{seller.id}</span> · {hostOf(seller.baseUrl)}
          </p>
        </div>
        <SellerStatusBadge status={seller.status} />
      </header>

      <ul className="sl-prices" aria-label="Prices per call">
        {seller.endpoints.map((ep) => (
          <li key={ep.id} title={ep.description ?? undefined}>
            <span className="sl-method">{ep.method}</span>
            <span className="sl-path">{ep.path}</span>
            <Money micros={ep.priceMicros} padTo={3} className="sl-price" />
          </li>
        ))}
      </ul>

      <dl className="sl-figures">
        <div>
          <dt>Owed</dt>
          <dd>
            <Money micros={seller.balanceMicros} />
          </dd>
          <dd className="sl-figure-hint">
            {seller.balanceMicros < 0
              ? "Fee share above earnings so far"
              : due
                ? "In the next payout"
                : `Paid once owed ${formatCents(thresholdCents)}`}
          </dd>
        </div>
        <div>
          <dt>Paid out</dt>
          <dd>
            <Money micros={seller.paidOutMicros} />
          </dd>
          <dd className="sl-figure-hint">Through PayPal payouts</dd>
        </div>
        <div>
          <dt>Voided</dt>
          <dd className={voidRate >= 10 ? "sl-void-high" : undefined}>{calls ? formatPct(voidRate, 1) : "None yet"}</dd>
          <dd className="sl-figure-hint">{calls ? `${formatCount(voids)} of ${formatCount(calls)} calls` : "No paid calls yet"}</dd>
        </div>
      </dl>

      <div className="sl-card-foot">
        <p className="sl-rules-text">
          <span className="muted">Not billed:</span> {voidRulesText(seller)}
        </p>
        <div className="sl-gateway">
          <span className="muted">Agents call</span>
          <code title={seller.gatewayUrl}>{seller.gatewayUrl.replace(/^https?:\/\//, "")}</code>
          <CopyButton value={seller.gatewayUrl} label="Copy" />
        </div>
        <div className="sl-card-actions">
          <span className="sl-payto">
            Payouts to <span className="mono">{seller.paypalEmail}</span>
          </span>
          <Button size="sm" variant="ghost" onClick={toggle} loading={busy}>
            {seller.status === "active" ? "Pause listing" : "Resume listing"}
          </Button>
        </div>
      </div>
    </article>
  );
}
