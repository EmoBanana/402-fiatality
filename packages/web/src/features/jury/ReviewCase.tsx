/**
 * A rogue-agent report: the alarm that paused the tab, the ruling (verdict, fault, confidence, the judge's
 * reason), the full debate, the calls it voided, and links to the tab and its statement. An escalated review
 * on a still-paused tab can be decided here, as in the console.
 */
import type { AlarmDTO, ReviewDTO, ReviewVerdict, TabDTO, VoucherDTO } from "@p402/shared";
import { useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Debate, SPEND_REVIEW_ROLES } from "../../components/Debate";
import { type DescriptionItem, DescriptionList } from "../../components/DescriptionList";
import { describeError, ErrorState } from "../../components/ErrorState";
import { Money } from "../../components/Money";
import { SkeletonText } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { formatDateTime, formatDuration, formatTime, plural, shortId, voidReasonLabel } from "../../lib/format";
import { useResource } from "../../lib/resource";
import { ALARM_HEADLINE, FAULT_LABEL, isOpenCase, juryModelLabel, REVIEW_OUTCOME, reviewOutcome } from "./docket";
import { CaseLinks, Confidence, Ruling } from "./parts";

function VoidedCalls({ review }: { review: ReviewDTO }) {
  const ids = review.voidedVoucherIds;
  const key = ids.join(",");
  // A tab's calls, newest first; the ones the review named are among its most recent.
  const vouchers = useResource((signal) => api.vouchers.list({ tabId: review.tabId, limit: 1000 }, signal), [review.tabId, key], {
    enabled: ids.length > 0,
  });
  if (ids.length === 0) return null;
  const applied = review.verdict === "void";
  const title = applied ? `Calls voided · ${ids.length}` : `Calls the judge flagged · ${ids.length}`;
  const wanted = new Set(ids);
  const rows: VoucherDTO[] = (vouchers.data ?? []).filter((v) => wanted.has(v.id)).sort((a, b) => a.createdAt - b.createdAt);
  const missing = vouchers.data ? ids.length - rows.length : 0;
  const total = rows.reduce((sum, v) => sum + v.priceMicros, 0);

  return (
    <section className="jy-section" aria-label={title}>
      <h4 className="jy-label">{title}</h4>
      <p className="jy-note">
        {applied
          ? "Bad data from the seller: these IOUs were voided, so nobody is charged for them."
          : "The judge named these calls but wasn't sure enough to void them alone."}
      </p>
      {vouchers.error ? (
        <ErrorState compact error={vouchers.error} onRetry={vouchers.reload} />
      ) : !vouchers.data ? (
        <div aria-busy="true" className="jy-skeleton">
          <SkeletonText lines={3} />
        </div>
      ) : (
        <Table
          dense
          caption={title}
          rows={rows}
          rowKey={(v) => v.id}
          rowTone={(v) => (v.status === "voided" ? "danger" : undefined)}
          empty={<p className="jy-note">These calls are older than the ledger keeps at hand.</p>}
          columns={[
            { key: "time", header: "Time", render: (v) => <span className="mono">{formatTime(v.createdAt)}</span> },
            { key: "seller", header: "Seller", render: (v) => <span className="mono">{v.sellerId}</span> },
            {
              key: "call",
              header: "Call",
              render: (v) => (
                <span className="mono jy-call" title={`${v.method} ${v.path}`}>
                  {v.method} {v.path}
                </span>
              ),
            },
            { key: "status", header: "Status", render: (v) => (v.status === "voided" ? voidReasonLabel(v.voidReason) : "Billable") },
            { key: "price", header: "Price", align: "right", render: (v) => <Money micros={v.priceMicros} padTo={3} /> },
          ]}
          footer={rows.length > 1 ? { time: "Total", price: <Money micros={total} padTo={3} /> } : undefined}
        />
      )}
      {missing > 0 ? <p className="jy-note">{plural(missing, "more call")} not shown: older than the most recent 1,000 on this tab.</p> : null}
    </section>
  );
}

function Decide({ review, onDecided }: { review: ReviewDTO; onDecided: (review: ReviewDTO) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function decide(verdict: Exclude<ReviewVerdict, "escalate">) {
    setBusy(verdict);
    try {
      onDecided(await api.reviews.decide(review.id, { verdict }));
      toast({ tone: "success", title: verdict === "resume" ? "Tab resumed" : verdict === "void" ? "Flagged calls voided, tab resumed" : "Agent frozen" });
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't record the decision") });
    } finally {
      setBusy(null);
    }
  }
  return (
    <section className="jy-decide" aria-label="Your decision">
      <p>
        <strong>The judge sent this to a human.</strong> The tab stays paused until you decide.
      </p>
      <div className="ui-cluster">
        <Button variant="primary" size="sm" onClick={() => decide("resume")} loading={busy === "resume"} disabled={Boolean(busy)}>
          Resume spending
        </Button>
        {review.voidedVoucherIds.length ? (
          <Button size="sm" onClick={() => decide("void")} loading={busy === "void"} disabled={Boolean(busy)}>
            Void the flagged calls
          </Button>
        ) : null}
        <Button variant="danger" size="sm" onClick={() => decide("freeze")} loading={busy === "freeze"} disabled={Boolean(busy)}>
          Freeze the agent
        </Button>
      </div>
    </section>
  );
}

export function ReviewCase({
  review,
  tab,
  alarm,
  tabs,
  onDecided,
}: {
  review: ReviewDTO;
  tab: TabDTO | undefined;
  alarm: AlarmDTO | undefined;
  tabs: ReadonlyMap<string, TabDTO>;
  onDecided: (review: ReviewDTO) => void;
}) {
  const outcome = reviewOutcome(review);
  const spec = REVIEW_OUTCOME[outcome];
  const running = review.status === "running";
  const open = isOpenCase({ kind: "review", id: review.id, at: review.createdAt, review }, tabs);
  const took = review.finishedAt ? review.finishedAt - review.createdAt : null;

  const facts: DescriptionItem[] = [
    { term: "Company", detail: tab?.companyName ?? tab?.companyId ?? "Unknown" },
    { term: "Tab", detail: tab?.label || "Untitled tab", hint: <span className="mono">{review.tabId}</span> },
    ...(alarm ? [{ term: "Alarm", detail: ALARM_HEADLINE[alarm.kind] ?? alarm.kind, hint: formatDateTime(alarm.createdAt) }] : []),
    {
      term: "Heard by",
      detail: review.decidedBy === "human" ? "Decided by a human" : juryModelLabel(review.model),
      hint: took != null ? `Ruled in ${formatDuration(took)}` : running ? "In session" : undefined,
    },
  ];

  return (
    <>
      <Ruling
        label={running ? "Hearing in progress" : "Ruling"}
        reason={running ? null : review.reason}
        pending="The prosecutor, the defender and the judge are weighing the last calls. Spending stays paused until they rule."
        meta={
          <>
            <Badge tone={spec.tone} dot={running}>
              {spec.label}
            </Badge>
            {review.fault ? <span>{FAULT_LABEL[review.fault]}</span> : null}
            <Confidence value={review.confidence} />
          </>
        }
      />

      {open && !running ? <Decide review={review} onDecided={onDecided} /> : null}

      <div className="jy-case-grid">
        <section className="jy-section" aria-label="The debate" aria-live={running ? "polite" : undefined}>
          <h4 className="jy-label">The debate</h4>
          {review.transcript.length || running ? (
            <Debate messages={review.transcript} running={running} roles={SPEND_REVIEW_ROLES} />
          ) : (
            <p className="jy-note">No debate was recorded: {review.reason ?? "the review ended before anyone spoke."}</p>
          )}
        </section>
        <aside className="jy-facts" aria-label="Case facts">
          {alarm ? (
            <div className="jy-alarm">
              <p className="jy-label">What called the jury</p>
              <p className="jy-alarm-text">{alarm.message}</p>
            </div>
          ) : null}
          <DescriptionList dense items={facts} />
          <CaseLinks tabId={review.tabId} />
          <p className="jy-id">
            Case <span className="mono" title={review.id}>{shortId(review.id, 6, 4)}</span>
          </p>
        </aside>
      </div>

      <VoidedCalls review={review} />
    </>
  );
}
