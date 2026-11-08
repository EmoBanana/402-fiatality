/**
 * The AI spend review: verdict summary plus the three-role debate (prosecutor, defender, judge).
 * `layout="columns"` puts the roles side by side (master/detail rows); `layout="stack"` lists the turns in
 * order (side panel). While a review runs, the next speaker shows a typing indicator.
 */
import type { ReviewDTO, ReviewMessageDTO, ReviewRole } from "@p402/shared";
import { Badge } from "../../components";
import { formatTime, modelLabel } from "../../lib/format";
import { FAULT_LABELS, REVIEW_STATE, ROLE_LABELS, ROLE_ORDER, reviewState } from "./labels";

/** The judge may answer with its structured JSON; show the reason rather than raw braces. */
function readable(message: ReviewMessageDTO): string {
  const text = message.content.trim();
  if (message.role !== "judge" || !text.startsWith("{")) return text;
  try {
    const parsed = JSON.parse(text) as { verdict?: string; reason?: string; confidence?: number };
    const parts = [parsed.verdict ? `Verdict: ${parsed.verdict}.` : "", parsed.reason ?? ""].filter(Boolean);
    return parts.join(" ") || text;
  } catch {
    return text;
  }
}

function nextSpeaker(review: ReviewDTO): ReviewRole | null {
  if (review.status !== "running") return null;
  const spoken = new Set(review.transcript.map((m) => m.role));
  return ROLE_ORDER.find((role) => !spoken.has(role)) ?? null;
}

function Typing() {
  return (
    <span className="tx-typing" aria-label="Writing">
      <span />
      <span />
      <span />
    </span>
  );
}

export function VerdictSummary({ review, compact = false, showReason = true }: { review: ReviewDTO; compact?: boolean; showReason?: boolean }) {
  const state = reviewState(review);
  const { label, tone } = REVIEW_STATE[state];
  const confidence = review.confidence != null ? Math.round(review.confidence * 100) : null;
  return (
    <div className="tx-verdict" data-compact={compact || undefined}>
      <div className="tx-verdict-line">
        <Badge tone={tone} dot={state === "running"} className={state === "running" ? "tx-live" : undefined}>
          {label}
        </Badge>
        {review.fault ? <span className="tx-verdict-meta">{FAULT_LABELS[review.fault]}</span> : null}
        {confidence != null ? (
          <span className="tx-verdict-meta tx-confidence" title={`Judge confidence ${confidence}%`}>
            <span className="tx-meter" aria-hidden="true">
              <span style={{ width: `${confidence}%` }} />
            </span>
            {confidence}% sure
          </span>
        ) : null}
        {review.decidedBy ? (
          <span className="tx-verdict-meta">
            {review.decidedBy === "human" ? "Decided by a human" : `Decided by ${modelLabel(review.model ?? "the AI")}`}
          </span>
        ) : review.model ? (
          <span className="tx-verdict-meta">{modelLabel(review.model)}</span>
        ) : null}
      </div>
      {showReason && review.reason ? <p className="tx-verdict-reason">{review.reason}</p> : null}
    </div>
  );
}

export function ReviewTranscript({ review, layout }: { review: ReviewDTO; layout: "columns" | "stack" }) {
  const next = nextSpeaker(review);

  if (layout === "stack") {
    return (
      <ol className="tx-debate" data-layout="stack">
        {review.transcript.map((message, i) => (
          <li key={`${message.role}-${message.at}-${i}`} className="tx-turn" data-role={message.role}>
            <header className="tx-turn-head">
              <span className="tx-role-dot" aria-hidden="true" />
              {ROLE_LABELS[message.role]}
              <time className="tx-turn-time">{formatTime(message.at)}</time>
            </header>
            <p className="tx-turn-text">{readable(message)}</p>
          </li>
        ))}
        {next ? (
          <li className="tx-turn" data-role={next} data-pending="true">
            <header className="tx-turn-head">
              <span className="tx-role-dot" aria-hidden="true" />
              {ROLE_LABELS[next]}
            </header>
            <Typing />
          </li>
        ) : null}
        {review.transcript.length === 0 && !next ? <li className="tx-turn-empty">No transcript was recorded for this review.</li> : null}
      </ol>
    );
  }

  return (
    <div className="tx-debate" data-layout="columns">
      {ROLE_ORDER.map((role) => {
        const messages = review.transcript.filter((m) => m.role === role);
        return (
          <section key={role} className="tx-turn" data-role={role} aria-label={ROLE_LABELS[role]}>
            <header className="tx-turn-head">
              <span className="tx-role-dot" aria-hidden="true" />
              {ROLE_LABELS[role]}
              {messages[0] ? <time className="tx-turn-time">{formatTime(messages[0].at)}</time> : null}
            </header>
            {messages.map((message, i) => (
              <p key={`${message.at}-${i}`} className="tx-turn-text">
                {readable(message)}
              </p>
            ))}
            {messages.length === 0 ? next === role ? <Typing /> : <p className="tx-turn-empty">{review.status === "running" ? "Waiting for the floor" : "No statement"}</p> : null}
          </section>
        );
      })}
    </div>
  );
}
