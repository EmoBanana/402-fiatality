/**
 * Right rail: the AI spend review debate (follows the live review, or the one picked from the alarm list)
 * and every alarm the detectors raised. An escalated review can be settled by a human from here.
 */
import type { AlarmDTO, ReviewDTO } from "@p402/shared";
import { useState } from "react";
import { Badge, Button, Card, EmptyState, useToast } from "../../components";
import { ApiError, api } from "../../lib/api";
import { formatTime, shortId } from "../../lib/format";
import { ALARM_KIND_LABELS, ALARM_STATUS, REVIEW_STATE, reviewState } from "./labels";
import { ReviewTranscript, VerdictSummary } from "./ReviewTranscript";
import { useFeed, useTerminal } from "./store";

function Decide({ review }: { review: ReviewDTO }) {
  const feed = useFeed();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const decide = async (verdict: "resume" | "void" | "freeze") => {
    setBusy(verdict);
    try {
      const updated = await api.reviews.decide(review.id, { verdict });
      feed.applyReview(updated);
      toast({ title: "Decision recorded", description: `Tab ${shortId(review.tabId)}: ${REVIEW_STATE[verdict].label.toLowerCase()}.`, tone: "success" });
    } catch (err) {
      toast({ title: "Couldn't record the decision", description: err instanceof ApiError ? err.message : String(err), tone: "danger" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="tx-decide">
      <p className="tx-decide-note">The judge wasn't confident enough to rule. Your call:</p>
      <div className="tx-decide-actions">
        <Button size="sm" loading={busy === "resume"} disabled={busy != null} onClick={() => void decide("resume")}>
          Resume
        </Button>
        <Button size="sm" loading={busy === "void"} disabled={busy != null} onClick={() => void decide("void")}>
          Void flagged
        </Button>
        <Button size="sm" variant="danger" loading={busy === "freeze"} disabled={busy != null} onClick={() => void decide("freeze")}>
          Freeze agent
        </Button>
      </div>
    </div>
  );
}

function AlarmItem({ alarm, review, active, onPick }: { alarm: AlarmDTO; review?: ReviewDTO; active: boolean; onPick: () => void }) {
  const badge = review ? REVIEW_STATE[reviewState(review)] : ALARM_STATUS[alarm.status];
  return (
    <li>
      <button
        type="button"
        className="tx-alarm"
        aria-pressed={active}
        onClick={onPick}
        disabled={!review}
        title={review ? "Show this review's debate" : "No review for this alarm"}
      >
        <span className="tx-alarm-top">
          <span className="tx-alarm-kind">{ALARM_KIND_LABELS[alarm.kind] ?? alarm.kind}</span>
          <time className="tx-alarm-time">{formatTime(alarm.createdAt)}</time>
        </span>
        <span className="tx-alarm-msg">{alarm.message}</span>
        <span className="tx-alarm-foot">
          <span className="tx-alarm-tab">tab {shortId(alarm.tabId)}</span>
          <Badge tone={badge.tone} dot={review?.status === "running"} className={review?.status === "running" ? "tx-live" : undefined}>
            {badge.label}
          </Badge>
        </span>
      </button>
    </li>
  );
}

export function ReviewPanel() {
  const feed = useFeed();
  const reviews = useTerminal((s) => s.reviews);
  const alarms = useTerminal((s) => s.alarms);
  const focusedId = useTerminal((s) => s.focusedReviewId);

  const live = reviews.find((r) => r.status === "running");
  const focused = (focusedId ? reviews.find((r) => r.id === focusedId) : undefined) ?? live ?? reviews[0];
  const alarm = focused?.alarmId ? alarms.find((a) => a.id === focused.alarmId) : undefined;
  const escalated = focused && focused.status !== "running" && focused.verdict === "escalate" && focused.decidedBy !== "human";
  const openAlarms = alarms.filter((a) => a.status !== "resolved").length;

  return (
    <>
      <Card
        className="tx-panel"
        padding="none"
        title={
          <span className="tx-panel-title">
            AI spend review
            {focused?.status === "running" ? (
              <Badge tone="accent" dot className="tx-live">
                Live
              </Badge>
            ) : null}
          </span>
        }
        subtitle={
          focused
            ? `${alarm ? ALARM_KIND_LABELS[alarm.kind] : "Review"} · tab ${shortId(focused.tabId)} · ${formatTime(focused.createdAt)}`
            : "Prosecutor, defender, judge"
        }
        actions={
          focusedId && live && focusedId !== live.id ? (
            <Button size="sm" variant="ghost" onClick={() => feed.focusReview(null)}>
              Follow live
            </Button>
          ) : undefined
        }
      >
        <div className="tx-panel-body">
          {focused ? (
            <>
              {alarm ? <p className="tx-review-alarm">{alarm.message}</p> : null}
              <VerdictSummary review={focused} compact />
              <ReviewTranscript review={focused} layout="stack" />
              {escalated ? <Decide review={focused} /> : null}
            </>
          ) : (
            <EmptyState
              title="No reviews yet"
              description="When an alarm pauses a tab, three AI roles argue over the spend here and the judge rules: resume, void bad data, or freeze the agent."
            />
          )}
        </div>
      </Card>

      <Card
        className="tx-panel"
        padding="none"
        title="Alarms"
        subtitle={alarms.length === 0 ? "Loops, error streaks, spikes, velocity" : `${openAlarms} open · ${alarms.length} total`}
      >
        {alarms.length === 0 ? (
          <EmptyState title="All quiet" description="Detectors watch every tab for repeated requests, error streaks, spend spikes and velocity." />
        ) : (
          <ul className="tx-alarms">
            {alarms.slice(0, 50).map((a) => {
              const review = reviews.find((r) => r.alarmId === a.id);
              return (
                <AlarmItem
                  key={a.id}
                  alarm={a}
                  review={review}
                  active={!!review && review.id === focused?.id}
                  onPick={() => review && feed.focusReview(review.id)}
                />
              );
            })}
          </ul>
        )}
      </Card>
    </>
  );
}
