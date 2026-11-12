/**
 * The buyer's printable statement for one tab (SPEC §9.2): the one PayPal charge, what was billable, carried and
 * voided, what was paid to each seller, PayPal disputes on the charge (with the AI jury's recommendation), the agent's
 * purchases with their refunds, and the PayPal references, including the invoice recorded for the charge. PayPal's fee
 * is the sellers' (the Sellers page shows it), so it isn't here. Prints black on white without the app chrome
 * (statement.css + base.css print rules).
 */
import type { DisputeDTO, InvoiceDTO, PurchaseDTO, PurchaseRefundDTO, StatementDTO } from "@p402/shared";
import { useEffect } from "react";
import { Link, useParams } from "react-router";
import { purchaseStatusSpec, TabStatusBadge } from "../components/Badge";
import { Button, buttonClassName } from "../components/Button";
import { Callout } from "../components/Callout";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconArrowLeft, IconArrowRight, IconExternal } from "../components/Icons";
import { Logo } from "../components/Logo";
import { Money } from "../components/Money";
import { Skeleton, SkeletonText } from "../components/Skeleton";
import { Table } from "../components/Table";
import { confidencePct, disputeBadge, disputeReasonLabel, RECOMMENDATION, sentenceCase } from "../features/jury/docket";
import "../features/statement/statement.css";
import { ApiError, api } from "../lib/api";
import { formatCount, formatDate, formatDateTime, formatUsd, plural, voidReasonLabel } from "../lib/format";
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

const INVOICE_STATUS: Record<string, string> = {
  PAID: "Paid",
  MARKED_AS_PAID: "Marked as paid",
  PARTIALLY_PAID: "Partly paid",
  SENT: "Sent",
  DRAFT: "Draft",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partly refunded",
  MARKED_AS_REFUNDED: "Marked as refunded",
  CANCELLED: "Cancelled",
};

function invoiceStatus(status: string): string {
  return INVOICE_STATUS[status.toUpperCase()] ?? sentenceCase(status);
}

function Invoice({ invoice }: { invoice: InvoiceDTO }) {
  return (
    <p className="st-invoice">
      PayPal invoice <span className="mono">{invoice.invoiceNumber}</span> · {invoiceStatus(invoice.status)} · <Money cents={invoice.amountCents} />
      {invoice.url ? (
        <>
          {" "}
          <a href={invoice.url} target="_blank" rel="noopener noreferrer" className="st-invoice-link ui-no-print">
            View on PayPal <IconExternal size={12} />
          </a>
        </>
      ) : null}
    </p>
  );
}

function juryLine(dispute: DisputeDTO): string {
  const jury = dispute.jury;
  if (!jury) return "Not heard yet";
  if (jury.status === "running") return "Hearing now";
  if (!jury.recommendation) return "No recommendation";
  const pct = confidencePct(jury.confidence);
  return `${RECOMMENDATION[jury.recommendation].label}${pct != null ? ` · ${pct}%` : ""}`;
}

function Disputes({ disputes }: { disputes: DisputeDTO[] }) {
  const refunded = disputes.reduce((sum, d) => sum + d.refundedCents, 0);
  return (
    <section aria-labelledby="st-disputes" className="st-section">
      <h2 id="st-disputes">Disputes</h2>
      <Table
        caption="PayPal disputes on this charge"
        rows={disputes}
        rowKey={(d) => d.id}
        columns={[
          {
            key: "dispute",
            header: "Dispute",
            render: (d) => (
              <span className="st-dispute">
                {disputeReasonLabel(d.reason)}
                <small>
                  <span className="mono">{d.id}</span> · opened {formatDate(d.createdAt)}
                </small>
              </span>
            ),
          },
          { key: "status", header: "Status", render: (d) => disputeBadge(d).label },
          { key: "jury", header: "AI jury", render: (d) => juryLine(d) },
          { key: "amount", header: "Disputed", align: "right", render: (d) => <Money cents={d.amountCents} padTo={2} /> },
          {
            key: "case",
            header: <span className="visually-hidden">Case</span>,
            align: "right",
            render: (d) => (
              <Link to={`/jury#${encodeURIComponent(d.id)}`} className="st-case-link ui-no-print" aria-label={`Open the jury's case on dispute ${d.id}`}>
                Case <IconArrowRight size={12} />
              </Link>
            ),
          },
        ]}
        footer={refunded > 0 ? { dispute: "Refunded to you through disputes", amount: <Money cents={refunded} padTo={2} /> } : undefined}
      />
    </section>
  );
}

const REFUND_STATUS: Record<PurchaseRefundDTO["status"], string> = {
  completed: "refunded",
  pending: "pending at PayPal",
  processing: "sent to PayPal",
  unknown: "not confirmed yet",
  failed: "failed at PayPal",
  rejected: "refused by PayPal",
};

/** What the agent bought on this tab: paid by separate PayPal checkouts, not part of the tab's charge. */
function Purchases({ purchases }: { purchases: PurchaseDTO[] }) {
  const refunded = purchases.reduce((sum, p) => sum + (p.refundedCents ?? 0), 0);
  return (
    <section aria-labelledby="st-purchases" className="st-section">
      <h2 id="st-purchases">Purchases</h2>
      <Table
        caption="Paid by separate PayPal checkouts, not part of the charge above"
        rows={purchases}
        rowKey={(p) => p.id}
        columns={[
          {
            key: "purchase",
            header: "Purchase",
            render: (p) => (
              <span className="st-dispute">
                {p.title}
                <small>
                  {p.merchant ? `${p.merchant} · ` : ""}
                  {p.paypalOrderId ? <span className="mono">{p.paypalOrderId}</span> : formatDate(p.createdAt)}
                </small>
              </span>
            ),
          },
          { key: "status", header: "Status", render: (p) => purchaseStatusSpec(p).label },
          {
            key: "refunds",
            header: "Refunds",
            render: (p) =>
              p.refunds?.length ? (
                <span className="st-dispute">
                  {p.refunds.map((r) => (
                    <small key={r.id}>
                      <Money cents={r.amountCents} padTo={2} /> {REFUND_STATUS[r.status]}
                      {r.paypalRefundId ? <span className="mono"> · {r.paypalRefundId}</span> : null}
                    </small>
                  ))}
                </span>
              ) : (
                <span className="muted">None</span>
              ),
          },
          { key: "amount", header: "Paid", align: "right", render: (p) => <Money cents={p.amountCents} padTo={2} /> },
        ]}
        footer={refunded > 0 ? { purchase: "Refunded to you", amount: <Money cents={refunded} padTo={2} /> } : undefined}
      />
    </section>
  );
}

function StatementBody({ statement }: { statement: StatementDTO }) {
  const { tab, company, settlement, voids } = statement;
  const settled = Boolean(settlement && settlement.status === "completed");
  const billable = settlement?.billableMicros ?? tab.totals.billableMicros + tab.carryInMicros;
  const lines = settlement?.lines.length ? settlement.lines : statement.sellers;
  const totalGross = lines.reduce((s, l) => s + l.grossMicros, 0);
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
        {statement.invoice ? <Invoice invoice={statement.invoice} /> : null}
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

        {/* What the buyer paid each seller. PayPal's fee is the sellers' (it comes out of what they receive), so it
            lives in the seller view, not here. */}
        <section aria-labelledby="st-sellers">
          <h2 id="st-sellers">By seller</h2>
          <Table
            dense
            caption="What you paid each seller"
            rows={lines}
            rowKey={(l) => l.sellerId}
            empty={<EmptyState compact title="No billable calls" description="Nothing was billed on this tab." />}
            columns={[
              { key: "seller", header: "Seller", render: (l) => l.sellerName ?? l.sellerId },
              { key: "calls", header: "Calls", align: "right", render: (l) => formatCount(l.calls) },
              { key: "paid", header: "Paid", align: "right", render: (l) => <Money micros={l.grossMicros} padTo={6} /> },
            ]}
            footer={{ seller: "Total", calls: formatCount(totalCalls), paid: <Money micros={totalGross} padTo={6} /> }}
            footerVariant="grand"
          />
        </section>
      </div>

      {statement.disputes?.length ? <Disputes disputes={statement.disputes} /> : null}
      {statement.purchases?.length ? <Purchases purchases={statement.purchases} /> : null}

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
            {statement.invoice ? (
              <div>
                <dt>Invoice</dt>
                <dd className="mono">{statement.invoice.id}</dd>
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
          <IconArrowLeft />
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
