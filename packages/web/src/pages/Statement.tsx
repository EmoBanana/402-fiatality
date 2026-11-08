/**
 * Printable statement for one tab (SPEC §9.2): the one PayPal charge, what was billable, carried and voided,
 * fees against per-call payments, the per-seller split and the PayPal references. Prints black on white
 * without the app chrome (statement.css + base.css print rules).
 */
import type { StatementDTO } from "@p402/shared";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { TabStatusBadge } from "../components/Badge";
import { Button, buttonClassName } from "../components/Button";
import { Callout } from "../components/Callout";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Logo } from "../components/Logo";
import { Money } from "../components/Money";
import { Skeleton, SkeletonText } from "../components/Skeleton";
import { Table } from "../components/Table";
import "../features/statement/statement.css";
import { ApiError, api } from "../lib/api";
import { formatCount, formatDate, formatDateTime, formatPct, formatUsd, plural, voidReasonLabel } from "../lib/format";
import { useResource } from "../lib/resource";

function Period({ statement }: { statement: StatementDTO }) {
  const { tab } = statement;
  const start = tab.authorizedAt ?? tab.createdAt;
  const end = tab.closedAt ?? statement.generatedAt;
  return (
    <>
      {formatDate(start)} to {formatDate(end)}
    </>
  );
}

function StatementBody({ statement }: { statement: StatementDTO }) {
  const { tab, company, settlement, fees, voids } = statement;
  const settled = Boolean(settlement && settlement.status === "completed");
  const billable = settlement?.billableMicros ?? tab.totals.billableMicros + tab.carryInMicros;
  const lines = settlement?.lines.length ? settlement.lines : statement.sellers;
  const totalGross = lines.reduce((s, l) => s + l.grossMicros, 0);
  const totalFee = lines.reduce((s, l) => s + l.feeShareMicros, 0);
  const totalNet = lines.reduce((s, l) => s + l.netMicros, 0);
  const totalCalls = lines.reduce((s, l) => s + l.calls, 0);
  const reasons = Object.entries(voids.byReason).sort((a, b) => b[1] - a[1]);
  const policy = tab.policy;

  return (
    <article className="st-paper" aria-labelledby="st-title">
      <header className="st-head">
        <div>
          <Logo />
          <p className="st-company">{company.name}</p>
          <p className="st-muted">{tab.label || "Untitled tab"}</p>
        </div>
        <div className="st-head-meta">
          <h1 id="st-title">Statement</h1>
          <dl>
            <div>
              <dt>Tab</dt>
              <dd className="mono">{tab.id}</dd>
            </div>
            <div>
              <dt>Period</dt>
              <dd>
                <Period statement={statement} />
              </dd>
            </div>
            <div>
              <dt>Issued</dt>
              <dd>{formatDate(statement.generatedAt)}</dd>
            </div>
          </dl>
        </div>
      </header>

      {!settled ? (
        <Callout tone="warning" title="Not charged yet" className="st-open">
          This tab is <TabStatusBadge status={tab.status} />. The figures below are what's billable so far; the one PayPal charge happens when the
          tab closes.
        </Callout>
      ) : null}

      <section className="st-hero" aria-label="The PayPal charge">
        <p className="st-label">{settled ? "One PayPal charge" : "Billable so far"}</p>
        <p className="st-charge">
          {settled && settlement ? <Money cents={settlement.chargedCents} /> : <Money micros={billable} />}
        </p>
        <p className="st-muted">
          {plural(settlement?.callCount ?? tab.totals.accepted, "billable call")} across {plural(lines.length, "seller")}
          {settlement?.captureId ? (
            <>
              {" "}
              · PayPal capture <span className="mono">{settlement.captureId}</span>
            </>
          ) : null}
        </p>
      </section>

      <div className="st-columns">
        <section aria-labelledby="st-summary">
          <h2 id="st-summary">Summary</h2>
          <ol className="ui-ledger st-ledger">
            <li className="ui-ledger-row">
              <span className="ui-ledger-label">Billable IOUs{tab.carryInMicros > 0 ? " (incl. carried in)" : ""}</span>
              <Money micros={billable} padTo={4} className="ui-ledger-amount" />
            </li>
            {tab.carryInMicros > 0 ? (
              <li className="ui-ledger-row st-sub">
                <span className="ui-ledger-label">Carried in from the last tab</span>
                <Money micros={tab.carryInMicros} padTo={4} className="ui-ledger-amount" />
              </li>
            ) : null}
            {settled && settlement ? (
              <>
                <li className="ui-ledger-total ui-ledger-grand">
                  <span className="ui-ledger-label">Charged on PayPal, to the cent</span>
                  <Money cents={settlement.chargedCents} padTo={4} className="ui-ledger-amount" />
                </li>
                <li className="ui-ledger-row">
                  <span className="ui-ledger-label">Carried to the next tab</span>
                  <Money micros={settlement.carryOutMicros} padTo={4} className="ui-ledger-amount" />
                </li>
              </>
            ) : null}
            <li className="ui-ledger-row st-voided">
              <span className="ui-ledger-label">Voided, never charged · {plural(voids.count, "call")}</span>
              <Money micros={voids.micros} padTo={4} className="ui-ledger-amount" />
            </li>
          </ol>
        </section>

        <section aria-labelledby="st-fees">
          <h2 id="st-fees">Fees</h2>
          <ol className="ui-ledger st-ledger">
            <li className="ui-ledger-row">
              <span className="ui-ledger-label">PayPal fee · {formatPct(fees.effectiveRatePct)}</span>
              <Money cents={fees.paypalFeeCents} padTo={2} className="ui-ledger-amount" />
            </li>
            <li className="ui-ledger-row">
              <span className="ui-ledger-label">If each call were a PayPal payment</span>
              <Money cents={fees.naiveFeeCents} padTo={2} className="ui-ledger-amount" />
            </li>
            <li className="ui-ledger-total ui-ledger-grand">
              <span className="ui-ledger-label">Saved by batching</span>
              <Money cents={fees.savedCents} padTo={2} className="ui-ledger-amount" />
            </li>
          </ol>
          <p className="st-note">The PayPal fee is split across sellers in proportion to what each earned.</p>
        </section>
      </div>

      <section aria-labelledby="st-sellers" className="st-section">
        <h2 id="st-sellers">By seller</h2>
        <Table
          caption="Gross, fee share and net for each seller"
          rows={lines}
          rowKey={(l) => l.sellerId}
          empty={<EmptyState compact title="No billable calls" description="Nothing was earned on this tab." />}
          columns={[
            { key: "seller", header: "Seller", render: (l) => l.sellerName ?? l.sellerId },
            { key: "calls", header: "Calls", align: "right", render: (l) => formatCount(l.calls) },
            { key: "gross", header: "Gross", align: "right", render: (l) => <Money micros={l.grossMicros} padTo={6} /> },
            { key: "fee", header: "PayPal fee share", align: "right", render: (l) => <Money micros={-l.feeShareMicros} padTo={6} /> },
            { key: "net", header: "Net to seller", align: "right", render: (l) => <Money micros={l.netMicros} padTo={6} /> },
          ]}
          footer={{
            seller: "Total",
            calls: formatCount(totalCalls),
            gross: <Money micros={totalGross} padTo={6} />,
            fee: <Money micros={-totalFee} padTo={6} />,
            net: <Money micros={totalNet} padTo={6} />,
          }}
          footerVariant="grand"
        />
      </section>

      <div className="st-columns st-section">
        <section aria-labelledby="st-voids">
          <h2 id="st-voids">Voided calls</h2>
          {reasons.length ? (
            <Table
              dense
              caption="Voided calls by reason"
              rows={reasons}
              rowKey={([reason]) => reason}
              columns={[
                { key: "reason", header: "Reason", render: ([reason]) => voidReasonLabel(reason) },
                { key: "calls", header: "Calls", align: "right", render: ([, count]) => formatCount(count) },
              ]}
              footer={{ reason: `Total · ${formatUsd(voids.micros)} not charged`, calls: formatCount(voids.count) }}
            />
          ) : (
            <p className="st-note">No call on this tab was voided.</p>
          )}
        </section>

        <section aria-labelledby="st-refs">
          <h2 id="st-refs">PayPal references</h2>
          <dl className="st-refs">
            <div>
              <dt>Order</dt>
              <dd className="mono">{tab.paypal.orderId ?? "None"}</dd>
            </div>
            <div>
              <dt>Authorization</dt>
              <dd className="mono">{tab.paypal.authorizationId ?? "None"}</dd>
            </div>
            {tab.paypal.reauthorizationId ? (
              <div>
                <dt>Reauthorization</dt>
                <dd className="mono">{tab.paypal.reauthorizationId}</dd>
              </div>
            ) : null}
            <div>
              <dt>Capture</dt>
              <dd className="mono">{settlement?.captureId ?? "Not captured yet"}</dd>
            </div>
            {settlement ? (
              <div>
                <dt>Settlement</dt>
                <dd className="mono">{settlement.id}</dd>
              </div>
            ) : null}
          </dl>
          <h2 className="st-policy-title">Policy</h2>
          <p className="st-note">
            Hold <Money cents={policy.holdCents} />, at most <Money micros={policy.perCallMaxMicros} /> a call and <Money micros={policy.dailyCapMicros} /> a
            day, {policy.allowedSellers.includes("*") ? "any listed seller" : `only ${policy.allowedSellers.join(", ")}`}.
          </p>
        </section>
      </div>

      <footer className="st-foot">
        Generated {formatDateTime(statement.generatedAt)} by 402 Fiatality. Amounts in US dollars; IOUs are priced to a millionth of a dollar and
        PayPal is charged to the cent, with the remainder carried forward.
      </footer>
    </article>
  );
}

export default function Statement() {
  const { tabId = "" } = useParams();
  const statement = useResource((signal) => api.tabs.statement(tabId, signal), [tabId]);
  const label = statement.data?.tab.label;

  useEffect(() => {
    const previous = document.title;
    document.title = `Statement · ${label ?? tabId} · 402 Fiatality`;
    return () => {
      document.title = previous;
    };
  }, [label, tabId]);

  return (
    <div className="st">
      <div className="st-actions ui-no-print">
        <Link to={`/console?tab=${encodeURIComponent(tabId)}`} className={buttonClassName({ variant: "ghost", size: "sm" })}>
          Back to the tab
        </Link>
        <Button variant="secondary" size="sm" onClick={() => window.print()} disabled={!statement.data}>
          Print or save as PDF
        </Button>
      </div>
      {statement.error ? (
        statement.error instanceof ApiError && statement.error.status === 404 ? (
          <div className="st-paper">
            <EmptyState
              title="No statement for this tab"
              description="There's no tab with this id on this gateway. Check the link, or open the console."
              action={
                <Link to="/console" className={buttonClassName({ variant: "primary" })}>
                  Open the console
                </Link>
              }
            />
          </div>
        ) : (
          <div className="st-paper">
            <ErrorState error={statement.error} onRetry={statement.reload} />
          </div>
        )
      ) : !statement.data ? (
        <div className="st-paper" aria-busy="true">
          <div className="st-head">
            <Skeleton width={160} height={28} />
            <Skeleton width={200} height={60} />
          </div>
          <div style={{ marginTop: 40 }}>
            <Skeleton width={240} height={48} />
          </div>
          <div style={{ marginTop: 40 }}>
            <SkeletonText lines={6} />
          </div>
        </div>
      ) : (
        <StatementBody statement={statement.data} />
      )}
    </div>
  );
}
