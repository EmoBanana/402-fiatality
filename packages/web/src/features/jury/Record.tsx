/**
 * The record: every case the jury heard as one mark, oldest to newest, colored by what it came to. Rogue-agent
 * cases are solid marks, disputes are rings. It doubles as the legend (counts per outcome) and as navigation:
 * a mark jumps to its case.
 */
import type { TabDTO } from "@p402/shared";
import { Money } from "../../components/Money";
import { formatCount, formatDate, formatDateTime, plural } from "../../lib/format";
import { disputeBadge, isOpenCase, type JuryCase, REVIEW_OUTCOME, type ReviewOutcome, reviewOutcome } from "./docket";

const MAX_MARKS = 160;

function markOf(c: JuryCase): { tone: string; label: string } {
  if (c.kind === "review") {
    const spec = REVIEW_OUTCOME[reviewOutcome(c.review)];
    return { tone: spec.tone, label: `Rogue agent · ${spec.label}` };
  }
  const spec = disputeBadge(c.dispute);
  return { tone: spec.tone, label: `PayPal dispute · ${spec.label}` };
}

/** "Nov 9 to Nov 11, 2026"; one date when they match; both years when they differ. */
function dateSpan(from: number, to: number): string {
  const a = formatDate(from);
  const b = formatDate(to);
  if (a === b) return a;
  const sameYear = new Date(from).getFullYear() === new Date(to).getFullYear();
  return `${sameYear ? a.replace(/, \d{4}$/, "") : a} to ${b}`;
}

const LEGEND: ReviewOutcome[] = ["frozen", "voided", "resumed", "human", "hearing"];

export function Record({ cases, tabs, onPick }: { cases: JuryCase[]; tabs: ReadonlyMap<string, Pick<TabDTO, "status">>; onPick: (id: string) => void }) {
  const marks = cases.slice(0, MAX_MARKS).reverse();
  const outcomes = new Map<ReviewOutcome, number>();
  let disputes = 0;
  let openDisputes = 0;
  let held = 0;
  for (const c of cases) {
    if (c.kind === "review") {
      const o = reviewOutcome(c.review);
      outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
    } else {
      disputes += 1;
      if (isOpenCase(c, tabs)) {
        openDisputes += 1;
        held += c.dispute.heldMicros;
      }
    }
  }
  // Cases are spaced by order, not time, so the span goes in words rather than on an axis.
  const first = marks[0];
  const last = marks[marks.length - 1];
  const span = first && last ? dateSpan(first.at, last.at) : null;

  return (
    <section className="ui-card jy-record" aria-labelledby="jy-record-title">
      <div className="jy-record-head">
        <h2 id="jy-record-title" className="jy-label">
          The record
        </h2>
        <p className="jy-record-total">
          {plural(cases.length, "case")} heard
          {span ? <span className="muted"> · {cases.length > MAX_MARKS ? `latest ${formatCount(MAX_MARKS)}, ` : ""}{span}</span> : null}
        </p>
      </div>
      <ol className="jy-tally" aria-label="Cases, oldest to newest">
        {marks.map((c) => {
          const mark = markOf(c);
          return (
            <li key={`${c.kind}-${c.id}`}>
              <button
                type="button"
                className="jy-mark"
                data-kind={c.kind}
                data-tone={mark.tone}
                aria-label={`${formatDateTime(c.at)}: ${mark.label}`}
                title={`${formatDateTime(c.at)} · ${mark.label}`}
                onClick={() => onPick(c.id)}
              />
            </li>
          );
        })}
      </ol>
      <ul className="jy-legend" aria-label="Outcomes">
        {LEGEND.filter((o) => outcomes.get(o)).map((o) => (
          <li key={o}>
            <span className="jy-swatch" data-kind="review" data-tone={REVIEW_OUTCOME[o].tone} aria-hidden="true" />
            <span>
              <span className="num">{formatCount(outcomes.get(o) ?? 0)}</span> {REVIEW_OUTCOME[o].label.toLowerCase()}
            </span>
          </li>
        ))}
        <li>
          <span className="jy-swatch" data-kind="dispute" data-tone="neutral" aria-hidden="true" />
          <span>
            {plural(disputes, "PayPal dispute")}
            {openDisputes ? (
              <span className="muted">
                {" "}
                · {formatCount(openDisputes)} open
                {held > 0 ? (
                  <>
                    , <Money micros={held} /> held from sellers
                  </>
                ) : null}
              </span>
            ) : null}
          </span>
        </li>
      </ul>
    </section>
  );
}
