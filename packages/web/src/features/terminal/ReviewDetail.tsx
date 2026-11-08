/**
 * Master/detail row under an IOU that went through an AI spend review: what raised the alarm, the verdict,
 * and the prosecutor / defender / judge debate. Live while the review runs (reads the store, which the feed
 * updates on every review.message).
 */
import type { CustomDetailCellRendererProps } from "ag-grid-react";
import { formatDateTime, formatUsd, shortId } from "../../lib/format";
import { ALARM_KIND_LABELS } from "./labels";
import { ReviewTranscript, VerdictSummary } from "./ReviewTranscript";
import { useFeed, useTerminal, type VoucherRow } from "./store";

export function ReviewDetail(props: CustomDetailCellRendererProps<VoucherRow>) {
  const feed = useFeed();
  const row = props.data;
  const reviews = useTerminal((s) => s.reviews);
  const alarms = useTerminal((s) => s.alarms);
  const review = row?.reviewId ? reviews.find((r) => r.id === row.reviewId) : undefined;

  if (!row || !review) {
    return (
      <div className="tx-detail">
        <p className="tx-detail-note">This IOU's review isn't available yet.</p>
      </div>
    );
  }

  const alarm = review.alarmId ? alarms.find((a) => a.id === review.alarmId) : undefined;
  const voidedHere = review.voidedVoucherIds.includes(row.id);
  const linked = feed.rowsForReview(review.id);
  const voidedMicros = linked.filter((r) => review.voidedVoucherIds.includes(r.id)).reduce((sum, r) => sum + r.priceMicros, 0);

  return (
    <div className="tx-detail" role="region" aria-label="AI spend review">
      <header className="tx-detail-head">
        <div className="tx-detail-title">
          <p className="tx-eyebrow">
            AI spend review · {formatDateTime(review.createdAt)} · tab <span className="mono">{shortId(review.tabId)}</span>
          </p>
          <h3>
            {alarm ? ALARM_KIND_LABELS[alarm.kind] : "Spend review"}
            {alarm ? <span className="tx-detail-alarm"> {alarm.message}</span> : null}
          </h3>
        </div>
        <VerdictSummary review={review} showReason={false} />
      </header>
      {review.reason ? (
        <p className="tx-ruling">
          <span className="tx-ruling-label">Ruling</span>
          {review.reason}
        </p>
      ) : null}
      <ReviewTranscript review={review} layout="columns" />
      <footer className="tx-detail-foot">
        {voidedHere ? "This IOU was voided by the review, so it is not billed." : "This IOU was part of the evidence the review read."}{" "}
        {review.voidedVoucherIds.length > 0
          ? `The review voided ${review.voidedVoucherIds.length} IOU${review.voidedVoucherIds.length === 1 ? "" : "s"}${voidedMicros ? ` worth ${formatUsd(voidedMicros)}` : ""}.`
          : review.status === "running"
            ? "The verdict is still being argued."
            : "It voided nothing."}
      </footer>
    </div>
  );
}
