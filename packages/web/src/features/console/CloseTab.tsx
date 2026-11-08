/**
 * Step 6: close the tab with one PayPal capture (billable floored to the cent; the sub-cent remainder
 * carries to the company's next tab), then the settlement as a short ledger and a link to the statement.
 */
import { effectiveRatePct, microsToCentsFloor, type SettlementDTO, type TabDetailDTO } from "@p402/shared";
import { useState } from "react";
import { Link } from "react-router";
import { SettlementStatusBadge } from "../../components/Badge";
import { Button, buttonClassName } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { describeError } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { Spinner } from "../../components/Spinner";
import { Table } from "../../components/Table";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { formatCents, formatCount, formatPct, plural } from "../../lib/format";

export function SettlementLedger({ settlement }: { settlement: SettlementDTO }) {
  const rate = effectiveRatePct(settlement.paypalFeeCents, settlement.chargedCents);
  return (
    <div className="cs-settlement">
      <ol className="ui-ledger cs-settlement-ledger">
        <li className="ui-ledger-row">
          <span className="ui-ledger-label">
            {plural(settlement.callCount, "billable call")}
            {settlement.voidCount ? ` · ${formatCount(settlement.voidCount)} voided, never charged` : ""}
          </span>
          <Money micros={settlement.billableMicros} padTo={4} className="ui-ledger-amount" />
        </li>
        <li className="ui-ledger-total ui-ledger-grand">
          <span className="ui-ledger-label">One PayPal charge</span>
          <Money cents={settlement.chargedCents} padTo={4} className="ui-ledger-amount" />
        </li>
        <li className="ui-ledger-row">
          <span className="ui-ledger-label">Carried to the next tab</span>
          <Money micros={settlement.carryOutMicros} padTo={4} className="ui-ledger-amount" />
        </li>
        <li className="ui-ledger-row">
          <span className="ui-ledger-label">PayPal fee · {formatPct(rate)}, split across sellers</span>
          <Money cents={settlement.paypalFeeCents} padTo={4} className="ui-ledger-amount" />
        </li>
        <li className="ui-ledger-row cs-settlement-naive">
          <span className="ui-ledger-label">Fees if every call were its own payment</span>
          <Money cents={settlement.naiveFeeCents} padTo={4} className="ui-ledger-amount" />
        </li>
      </ol>
      {settlement.lines.length ? (
        <Table
          dense
          caption="What each seller earned from this tab"
          rows={settlement.lines}
          rowKey={(l) => l.sellerId}
          columns={[
            { key: "seller", header: "Seller", render: (l) => l.sellerName ?? l.sellerId },
            { key: "calls", header: "Calls", align: "right", render: (l) => formatCount(l.calls) },
            { key: "gross", header: "Gross", align: "right", render: (l) => <Money micros={l.grossMicros} padTo={6} /> },
            { key: "fee", header: "Fee share", align: "right", render: (l) => <Money micros={-l.feeShareMicros} padTo={6} /> },
            { key: "net", header: "Net to seller", align: "right", render: (l) => <Money micros={l.netMicros} padTo={6} /> },
          ]}
        />
      ) : null}
      {settlement.captureId ? (
        <p className="cs-note muted">
          PayPal capture <span className="mono">{settlement.captureId}</span>
        </p>
      ) : null}
    </div>
  );
}

export function CloseTab({ tab, onSettled }: { tab: TabDetailDTO; onSettled: (settlement: SettlementDTO) => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const settlement = [...tab.settlements].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
  const owed = tab.totals.billableMicros + tab.carryInMicros;
  const { cents, remainderMicros } = microsToCentsFloor(owed);
  const open = tab.status === "active" || tab.status === "paused" || tab.status === "frozen";

  async function close() {
    setClosing(true);
    setError(null);
    try {
      const result = await api.tabs.close(tab.id);
      onSettled(result);
      setConfirming(false);
      toast({ tone: "success", title: "Tab closed", description: result.chargedCents ? `One PayPal charge of ${formatCents(result.chargedCents)}.` : "Nothing was billable; the hold was released." });
    } catch (err) {
      setError(err);
    } finally {
      setClosing(false);
    }
  }

  if (tab.status === "pending_approval") return <p className="muted cs-note">Nothing to close until PayPal approves the hold.</p>;

  if (tab.status === "closing" || (closing && !settlement)) {
    return (
      <p className="cs-note">
        <Spinner size={14} label="Charging" /> Charging PayPal once for everything billable…
      </p>
    );
  }

  if (settlement && (tab.status === "settled" || settlement.status === "completed")) {
    return (
      <div className="ui-card cs-settled">
        <header className="cs-settled-head">
          <div>
            <h3>Settled with one PayPal charge</h3>
            <p className="muted">The rest of the hold was released. Sellers are paid in the next weekly payout.</p>
          </div>
          <SettlementStatusBadge status={settlement.status} />
        </header>
        <SettlementLedger settlement={settlement} />
        <div className="cs-row">
          <Link to={`/statements/${encodeURIComponent(tab.id)}`} className={buttonClassName({ variant: "primary" })}>
            View statement
          </Link>
          <Link to="/console" className={buttonClassName({ variant: "ghost" })}>
            Open a new tab
          </Link>
        </div>
      </div>
    );
  }

  const failed = tab.status === "failed" || settlement?.status === "failed";

  return (
    <div className="cs-close">
      {failed ? (
        <Callout tone="danger" title="The PayPal charge failed">
          {settlement?.error ?? "Nothing was captured; the calls stay unsettled so you can try again."}
        </Callout>
      ) : null}
      {open || failed ? (
        <>
          <p className="cs-close-text">
            {cents > 0 ? (
              <>
                Charges <Money cents={cents} /> in one PayPal capture. The rest of the <Money cents={tab.holdCents} /> hold is released
                {remainderMicros > 0 ? (
                  <>
                    , and <Money micros={remainderMicros} /> under a cent carries to the next tab.
                  </>
                ) : (
                  "."
                )}
              </>
            ) : (
              "Nothing is billable yet. Closing releases the whole hold and charges nothing."
            )}
          </p>
          {confirming ? (
            <div className="cs-confirm" role="group" aria-label="Confirm closing the tab">
              <span>{cents > 0 ? `Charge ${formatCents(cents)} to PayPal now?` : "Close the tab and release the hold?"}</span>
              <Button variant="primary" onClick={close} loading={closing}>
                {cents > 0 ? `Charge ${formatCents(cents)}` : "Close tab"}
              </Button>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={closing}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button onClick={() => setConfirming(true)}>{failed ? "Try the charge again" : cents > 0 ? `Close tab and charge ${formatCents(cents)}` : "Close tab"}</Button>
          )}
          {error ? (
            <Callout tone="danger" title={describeError(error, "Couldn't close the tab").title}>
              {describeError(error).description}
            </Callout>
          ) : null}
        </>
      ) : (
        <p className="muted cs-note">This tab is {tab.status}.</p>
      )}
    </div>
  );
}
