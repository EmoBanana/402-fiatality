/**
 * One case on the docket: a summary line (when, what kind, who, what happened, the outcome) that opens the
 * full report below it. The article's id is the case id, so /jury#<id> can land on it.
 */
import type { ReactNode } from "react";
import { Badge, type BadgeTone } from "../../components/Badge";
import { formatDate, formatTime } from "../../lib/format";

export interface CaseSummary {
  kind: "review" | "dispute";
  /** "Rogue agent", "PayPal dispute · Inquiry" */
  eyebrow: string;
  title: ReactNode;
  line: ReactNode;
  badge: { label: string; tone: BadgeTone };
  /** Fault and confidence, or the jury's recommendation. */
  meta?: ReactNode;
  live?: boolean;
}

export function CaseRow({ id, at, open, onToggle, summary, children }: { id: string; at: number; open: boolean; onToggle: () => void; summary: CaseSummary; children: ReactNode }) {
  const bodyId = `${id}-report`;
  return (
    <article id={id} className="jy-case" data-kind={summary.kind} data-open={open} aria-label={`${summary.eyebrow}, ${formatDate(at)}`}>
      <h3 className="jy-case-heading">
        <button type="button" className="jy-case-summary" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
          <span className="jy-case-when">
            <span>{formatDate(at).replace(/, \d{4}$/, "")}</span>
            <span className="jy-case-time">{formatTime(at).slice(0, 5)}</span>
          </span>
          <span className="jy-case-main">
            <span className="jy-case-kind">{summary.eyebrow}</span>
            <span className="jy-case-title">{summary.title}</span>
            <span className="jy-case-line">{summary.line}</span>
          </span>
          <span className="jy-case-side">
            <Badge tone={summary.badge.tone} dot={summary.live}>
              {summary.badge.label}
            </Badge>
            {summary.meta != null ? <span className="jy-case-meta">{summary.meta}</span> : null}
          </span>
          <span className="jy-case-chevron" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </button>
      </h3>
      <div id={bodyId} className="jy-case-body" hidden={!open}>
        {open ? children : null}
      </div>
    </article>
  );
}
