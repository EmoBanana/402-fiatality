/**
 * Shown while a tab is paused or frozen: the alarm, the AI spend review as it streams (prosecutor,
 * defender, judge), the verdict, and the human decision when the review escalates. A frozen agent links to
 * the jury's full report (/jury#<reviewId>).
 */
import type { AlarmDTO, ReviewVerdict, TabDetailDTO } from "@p402/shared";
import { useState } from "react";
import { Link } from "react-router";
import { ReviewVerdictBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Debate, SPEND_REVIEW_ROLES } from "../../components/Debate";
import { describeError } from "../../components/ErrorState";
import { IconArrowRight } from "../../components/Icons";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { modelLabel, plural } from "../../lib/format";

const ALARM_TITLE: Record<AlarmDTO["kind"], string> = {
  repeat_request: "The agent repeated itself",
  error_streak: "Too many failed calls in a row",
  spend_spike: "Spending spiked",
  velocity: "Calls came too fast",
  budget_threshold: "Most of the hold is spent",
};

function latest<T extends { createdAt: number }>(list: T[]): T | null {
  return list.reduce<T | null>((best, item) => (!best || item.createdAt > best.createdAt ? item : best), null);
}

export function ReviewBanner({ tab, onChanged }: { tab: TabDetailDTO; onChanged: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const review = latest(tab.reviews);
  const alarm = latest(tab.alarms.filter((a) => a.kind !== "budget_threshold"));
  const paused = tab.status === "paused";
  const frozen = tab.status === "frozen";
  // The tab's status is the source of truth: reviews only run while it's paused, so a review still marked
  // running on an active tab is stale (e.g. a missed review.finished) and the banner stays away.
  if (!paused && !frozen) return null;
  const running = paused && review?.status === "running";

  const escalated = Boolean(review && review.status !== "running" && (review.verdict === "escalate" || review.status === "failed") && paused);
  const tone = frozen ? "danger" : "warning";
  const model = review?.model ? modelLabel(review.model) : "Gemma";

  const title = frozen
    ? "The agent is frozen"
    : escalated
      ? "The review needs your decision"
      : alarm
        ? `Paused: ${ALARM_TITLE[alarm.kind] ?? alarm.message}`
        : "Paused";
  const lead = frozen
    ? (review?.reason ?? "Spending is stopped for good. Sellers keep payment for the good data they delivered; close the tab to charge it.")
    : escalated
      ? "The judge wasn't confident enough to act alone. Read the debate and pick an outcome."
      : running
        ? `Spending is on hold while ${model} reviews the recent calls. ${alarm?.message ?? ""}`.trim()
        : (alarm?.message ?? "Spending is on hold.");

  async function decide(verdict: Exclude<ReviewVerdict, "escalate">) {
    if (!review) return;
    setBusy(verdict);
    try {
      await api.reviews.decide(review.id, { verdict });
      toast({ tone: "success", title: verdict === "resume" ? "Tab resumed" : verdict === "void" ? "Flagged calls voided, tab resumed" : "Agent frozen" });
      onChanged();
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't record the decision") });
    } finally {
      setBusy(null);
    }
  }

  async function act(kind: "resume" | "freeze") {
    setBusy(kind);
    try {
      await (kind === "resume" ? api.tabs.resume(tab.id) : api.tabs.freeze(tab.id));
      toast({ tone: "success", title: kind === "resume" ? "Tab resumed" : "Tab frozen" });
      onChanged();
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, kind === "resume" ? "Couldn't resume the tab" : "Couldn't freeze the tab") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="cs-review" data-tone={tone} aria-labelledby="cs-review-title" aria-live="polite">
      <header className="cs-review-head">
        <div style={{ minWidth: 0 }}>
          <p className="ui-eyebrow cs-review-eyebrow">{frozen ? "Frozen" : running ? "AI spend review" : "Paused"}</p>
          <h2 id="cs-review-title">{title}</h2>
          <p className="cs-review-lead">{lead}</p>
        </div>
        {review?.verdict ? <ReviewVerdictBadge verdict={review.verdict} /> : running ? <Spinner label="Review in progress" /> : null}
      </header>

      {review ? <Debate messages={review.transcript} running={review.status === "running"} roles={SPEND_REVIEW_ROLES} /> : null}

      {review && review.status !== "running" && review.reason ? (
        <p className="cs-review-verdict">
          <span className="muted">Verdict</span> {review.reason}
          {typeof review.confidence === "number" ? <span className="muted"> · confidence {review.confidence.toFixed(2)}</span> : null}
          {review.voidedVoucherIds.length ? <span className="muted"> · {plural(review.voidedVoucherIds.length, "call")} flagged</span> : null}
          {review.decidedBy === "human" ? <span className="muted"> · decided by you</span> : null}
        </p>
      ) : null}

      {frozen && review && review.status !== "running" ? (
        <p className="cs-review-report">
          <Link to={`/jury#${encodeURIComponent(review.id)}`}>
            Read the jury's report <IconArrowRight size={14} />
          </Link>
        </p>
      ) : null}

      {escalated ? (
        <div className="cs-review-actions">
          <Button variant="primary" onClick={() => decide("resume")} loading={busy === "resume"} disabled={Boolean(busy)}>
            Resume spending
          </Button>
          <Button onClick={() => decide("void")} loading={busy === "void"} disabled={Boolean(busy)}>
            Void the flagged calls
          </Button>
          <Button variant="danger" onClick={() => decide("freeze")} loading={busy === "freeze"} disabled={Boolean(busy)}>
            Freeze the agent
          </Button>
        </div>
      ) : paused && !running ? (
        <div className="cs-review-actions">
          <Button variant="primary" onClick={() => act("resume")} loading={busy === "resume"} disabled={Boolean(busy)}>
            Resume tab
          </Button>
          <Button variant="danger" onClick={() => act("freeze")} loading={busy === "freeze"} disabled={Boolean(busy)}>
            Freeze tab
          </Button>
        </div>
      ) : null}
    </section>
  );
}
