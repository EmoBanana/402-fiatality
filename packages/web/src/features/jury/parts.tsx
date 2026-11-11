/** Small pieces both kinds of case share: the confidence gauge, the ruling block and the links out. */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { IconArrowRight } from "../../components/Icons";
import { confidencePct } from "./docket";

export function Confidence({ value, label = "sure" }: { value: number | null | undefined; label?: string }) {
  const pct = confidencePct(value);
  if (pct == null) return null;
  return (
    <span className="jy-confidence" title={`The judge's confidence: ${pct}%`}>
      <span className="jy-confidence-track" aria-hidden="true">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="num">
        {pct}% {label}
      </span>
    </span>
  );
}

/** The judge's reason set as the ruling, with what it decided underneath. */
export function Ruling({ label, reason, meta, pending }: { label: string; reason?: string | null; meta: ReactNode; pending?: ReactNode }) {
  return (
    <section className="jy-ruling" aria-label={label}>
      <p className="jy-label">{label}</p>
      {reason ? <blockquote className="jy-reason">{reason}</blockquote> : pending ? <p className="jy-reason jy-reason-pending">{pending}</p> : null}
      <div className="jy-ruling-meta">{meta}</div>
    </section>
  );
}

export function CaseLinks({ tabId, statement = true }: { tabId: string | null | undefined; statement?: boolean }) {
  if (!tabId) return null;
  const id = encodeURIComponent(tabId);
  return (
    <ul className="jy-links">
      <li>
        <Link to={`/console?tab=${id}`}>
          Open the tab in the console <IconArrowRight size={14} />
        </Link>
      </li>
      {statement ? (
        <li>
          <Link to={`/statements/${id}`}>
            View its statement <IconArrowRight size={14} />
          </Link>
        </li>
      ) : null}
    </ul>
  );
}
