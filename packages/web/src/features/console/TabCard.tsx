/**
 * The live tab card: spend against the hold, what's left, voids, and PayPal's clock (honor window,
 * renewal, charge date) measured on the gateway clock, which the demo can fast-forward.
 */
import type { TabDTO } from "@p402/shared";
import { TabStatusBadge } from "../../components/Badge";
import { Badge } from "../../components/Badge";
import { CopyButton } from "../../components/CopyButton";
import { type DescriptionItem, DescriptionList } from "../../components/DescriptionList";
import { Meter } from "../../components/Meter";
import { Money } from "../../components/Money";
import { useGatewayClock, useGatewayNow } from "../../lib/clock";
import { formatCount, formatDateTime, formatDuration, formatUsd, plural, shortId } from "../../lib/format";

/** "in 2 d 21 h" / "3 h ago" from the gateway's now. */
export function until(at: number, now: number): string {
  const diff = at - now;
  if (Math.abs(diff) < 60_000) return "now";
  return diff > 0 ? `in ${formatDuration(diff)}` : `${formatDuration(-diff)} ago`;
}

export function TabCard({ tab }: { tab: TabDTO }) {
  const now = useGatewayNow(10_000);
  const { demoOffsetMs } = useGatewayClock();
  const holdMicros = tab.holdCents * 10_000;
  const { totals, policy } = tab;
  const billable = totals.billableMicros;
  const pending = tab.status === "pending_approval";
  const closed = tab.status === "settled" || tab.status === "cancelled" || tab.status === "failed";
  const pct = holdMicros > 0 ? billable / holdMicros : 0;
  const tone = tab.status === "frozen" ? "danger" : !closed && pct >= policy.alarms.budgetWarnPct / 100 ? "warning" : "accent";
  const smallTab = tab.reauthorizeAt && tab.authorizedAt ? tab.reauthorizeAt - tab.authorizedAt > 10 * 86_400_000 : false;

  const schedule: DescriptionItem[] = pending
    ? [{ term: "PayPal dates", detail: <span className="muted">Set when you approve</span> }]
    : [
        ...(tab.honorUntil
          ? [{ term: "Honor window", detail: tab.honorUntil > now ? `ends ${until(tab.honorUntil, now)}` : `ended ${until(tab.honorUntil, now)}`, hint: formatDateTime(tab.honorUntil) }]
          : []),
        ...(tab.reauthorizedAt
          ? [{ term: "Renewed", detail: until(tab.reauthorizedAt, now), hint: formatDateTime(tab.reauthorizedAt) }]
          : tab.reauthorizeAt
            ? [{ term: smallTab ? "Renews (small tab)" : "Renews", detail: until(tab.reauthorizeAt, now), hint: formatDateTime(tab.reauthorizeAt) }]
            : []),
        ...(tab.closedAt
          ? [{ term: "Charged", detail: until(tab.closedAt, now), hint: formatDateTime(tab.closedAt) }]
          : tab.closeAt
            ? [{ term: "Charges by", detail: until(tab.closeAt, now), hint: formatDateTime(tab.closeAt) }]
            : []),
      ];

  const details: DescriptionItem[] = [
    {
      term: "Calls",
      detail: formatCount(totals.calls),
      hint: totals.calls ? `${formatCount(totals.accepted)} billable · ${formatCount(totals.voided)} voided` : undefined,
    },
    ...(closed
      ? []
      : [
          {
            term: "Today",
            detail: <Money micros={totals.spentTodayMicros} />,
            hint: `of ${formatUsd(policy.dailyCapMicros)} daily cap`,
          },
        ]),
    ...schedule,
    ...(tab.carryInMicros > 0 ? [{ term: "Carried in", detail: <Money micros={tab.carryInMicros} />, hint: "Sub-cent remainder from the last tab" }] : []),
    ...(tab.paypal.orderId ? [{ term: "PayPal order", detail: <span className="mono">{tab.paypal.orderId}</span> }] : []),
    ...(tab.paypal.reauthorizationId || tab.paypal.authorizationId
      ? [{ term: "Authorization", detail: <span className="mono">{tab.paypal.reauthorizationId ?? tab.paypal.authorizationId}</span> }]
      : []),
  ];

  return (
    <section className="ui-card cs-tabcard" aria-labelledby="cs-tabcard-title">
      <header className="cs-tabcard-head">
        <h2 id="cs-tabcard-title" className="visually-hidden">
          Tab summary
        </h2>
        <p className="cs-tabcard-id">
          <span className="mono" title={tab.id}>
            {shortId(tab.id, 6, 4)}
          </span>
          <CopyButton value={tab.id} label="Copy id" />
        </p>
        <TabStatusBadge status={tab.status} />
      </header>

      <div className="cs-tabcard-spend">
        <p className="ui-stat-label">{closed ? "Billable" : "Spent"}</p>
        <p className="cs-tabcard-amount">
          <Money micros={billable} />
          <span className="cs-tabcard-of">
            of <Money cents={tab.holdCents} /> hold
          </span>
        </p>
        <Meter
          value={billable}
          max={holdMicros}
          tone={tone}
          ariaValueText={`${formatUsd(billable)} of ${formatUsd(holdMicros)}`}
          marks={[
            ...(policy.closeAtCents < tab.holdCents ? [{ at: policy.closeAtCents * 10_000, label: `Charges at ${formatUsd(policy.closeAtCents * 10_000)}` }] : []),
            { at: (holdMicros * policy.alarms.budgetWarnPct) / 100, label: `Warning at ${policy.alarms.budgetWarnPct}%` },
          ]}
        />
        <div className="cs-tabcard-pair">
          <div>
            <span className="muted">Remaining</span>
            <Money micros={totals.remainingMicros} />
          </div>
          <div>
            <span className="muted">Voided</span>
            <span className={totals.voided ? "cs-void" : undefined}>
              {plural(totals.voided, "call")} · <Money micros={totals.voidedMicros} />
            </span>
          </div>
        </div>
      </div>

      <div className="cs-tabcard-details">
        <DescriptionList items={details} dense />
        {demoOffsetMs > 0 ? (
          <p className="cs-tabcard-clock">
            <Badge tone="warning">Demo clock +{formatDuration(demoOffsetMs)}</Badge>
          </p>
        ) : null}
      </div>
    </section>
  );
}
