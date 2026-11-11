/**
 * The AI jury's docket: every case it has heard, newest first. A rogue-agent case is a spend review (an
 * alarm paused a tab; prosecutor, defender and judge argued over the spending). A dispute case is a PayPal
 * dispute on a tab's one charge, with the jury's recommended response. Filter with ?show=rogue|disputes|open;
 * /jury#<case id> opens a case and scrolls to it. Live from /ws: debates stream in as they happen.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Button, buttonClassName } from "../components/Button";
import { Callout } from "../components/Callout";
import { Card } from "../components/Card";
import { EmptyState } from "../components/EmptyState";
import { describeError, ErrorState } from "../components/ErrorState";
import { PageHeader } from "../components/PageHeader";
import { Skeleton } from "../components/Skeleton";
import { useToast } from "../components/Toast";
import { CaseRow, type CaseSummary } from "../features/jury/CaseRow";
import { DisputeCase } from "../features/jury/DisputeCase";
import {
  ALARM_HEADLINE,
  buildDocket,
  CASE_FILTERS,
  type CaseFilter,
  confidencePct,
  disputeBadge,
  disputeReasonLabel,
  FAULT_LABEL,
  isOpenCase,
  type JuryCase,
  matchesFilter,
  parseFilter,
  RECOMMENDATION,
  REVIEW_OUTCOME,
  reviewOutcome,
} from "../features/jury/docket";
import "../features/jury/jury.css";
import { Record } from "../features/jury/Record";
import { ReviewCase } from "../features/jury/ReviewCase";
import { isDispute, useDocket } from "../features/jury/useDocket";
import { ApiError, api } from "../lib/api";
import { useGatewayConfig } from "../lib/config";
import { formatCents, formatCount, formatDate, plural } from "../lib/format";

function Chips({ value, counts, onChange }: { value: CaseFilter; counts: Record<CaseFilter, number>; onChange: (value: CaseFilter) => void }) {
  return (
    <fieldset className="jy-chips">
      <legend className="visually-hidden">Show</legend>
      {CASE_FILTERS.map((f) => (
        <label key={f.value}>
          <input type="radio" name="jy-show" value={f.value} checked={value === f.value} onChange={() => onChange(f.value)} />
          <span className="jy-chip">
            {f.label}
            <span className="jy-chip-count">{formatCount(counts[f.value])}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function DocketSkeleton() {
  return (
    <div className="jy-docket" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="jy-case jy-case-skeleton">
          <Skeleton width={56} height={28} />
          <div className="ui-stack" style={{ ["--stack-gap" as string]: "8px", flex: 1 }}>
            <Skeleton width={120} height={12} />
            <Skeleton width="45%" height={18} />
            <Skeleton width="70%" height={13} />
          </div>
          <Skeleton width={96} height={22} radius={999} />
        </div>
      ))}
    </div>
  );
}

/** "#rev_123" -> "rev_123"; a malformed escape (a hand-edited URL) is no case rather than a crash. */
function caseIdFromHash(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}

const EMPTY: Record<CaseFilter, { title: string; description: string }> = {
  all: {
    title: "No cases yet",
    description: "The jury sits when an alarm pauses a tab or a company disputes a charge on PayPal. Run the runaway agent in the console to see a hearing.",
  },
  rogue: {
    title: "No rogue agents so far",
    description: "When an alarm pauses a tab, the jury's report on that agent lands here. Try the runaway agent in the console.",
  },
  disputes: {
    title: "No PayPal disputes",
    description: "When a company disputes a tab's charge on PayPal, the case appears here with the jury's recommended response.",
  },
  open: {
    title: "Nothing waiting on anyone",
    description: "Every hearing has ended and every dispute is resolved.",
  },
};

export default function Jury() {
  const docket = useDocket();
  const toast = useToast();
  const config = useGatewayConfig().data;
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get("show"));
  const location = useLocation();
  const navigate = useNavigate();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [busy, setBusy] = useState<"sync" | "simulate" | null>(null);
  const mock = config?.paypalMode === "mock";

  const cases = useMemo(() => buildDocket(docket.reviews ?? [], docket.disputes ?? []), [docket.reviews, docket.disputes]);
  const visible = cases.filter((c) => matchesFilter(c, filter, docket.tabs));
  const counts = useMemo(() => {
    const result: Record<CaseFilter, number> = { all: cases.length, rogue: 0, disputes: 0, open: 0 };
    for (const c of cases) {
      if (c.kind === "review") result.rogue += 1;
      else result.disputes += 1;
      if (isOpenCase(c, docket.tabs)) result.open += 1;
    }
    return result;
  }, [cases, docket.tabs]);

  const setFilter = useCallback(
    (value: CaseFilter) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (value === "all") next.delete("show");
          else next.set("show", value);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setParams],
  );

  /**
   * Open a case and bring it into view, with its id in the URL. One navigation does both the hash and, when the
   * current filter would hide the case, the switch back to All (two navigations in a row would drop the hash).
   */
  const [handledHash, setHandledHash] = useState<string | null>(null);
  const reveal = useCallback(
    (target: JuryCase, visible: boolean) => {
      setHandledHash(target.id);
      setOpenIds((current) => new Set(current).add(target.id));
      setScrollTo(target.id);
      navigate({ search: visible ? location.search : "", hash: encodeURIComponent(target.id) }, { replace: true, preventScrollReset: true });
    },
    [navigate, location.search],
  );

  // Deep link: /jury#<case id>, once that case has loaded (or arrives live).
  const hash = caseIdFromHash(location.hash);
  useEffect(() => {
    if (!hash || hash === handledHash) return;
    const target = cases.find((c) => c.id === hash);
    if (!target) return;
    reveal(target, matchesFilter(target, filter, docket.tabs));
  }, [hash, handledHash, cases, filter, docket.tabs, reveal]);

  useEffect(() => {
    if (!scrollTo) return;
    const el = document.getElementById(scrollTo);
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    el.querySelector<HTMLElement>(".jy-case-summary")?.focus({ preventScroll: true });
    setScrollTo(null);
  }, [scrollTo, visible]);

  const pick = (id: string) => {
    const target = cases.find((c) => c.id === id);
    if (target) reveal(target, matchesFilter(target, filter, docket.tabs));
  };

  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function sync() {
    setBusy("sync");
    try {
      const result = await api.disputes.sync();
      toast({
        tone: "success",
        title: "Synced with PayPal",
        description:
          result.created || result.updated
            ? `${plural(result.created, "new dispute")}, ${plural(result.updated, "update")}.`
            : `Checked ${plural(result.checked, "dispute")}; nothing new.`,
      });
      await docket.reload();
    } catch (err) {
      const missing = err instanceof ApiError && err.status === 404;
      toast({
        tone: missing ? "warning" : "danger",
        ...(missing
          ? { title: "Disputes aren't connected yet", description: "This gateway doesn't serve PayPal disputes yet." }
          : describeError(err, "Couldn't sync with PayPal")),
      });
    } finally {
      setBusy(null);
    }
  }

  async function simulate() {
    setBusy("simulate");
    try {
      const settlements = await api.settlements.list();
      const disputed = new Set((docket.disputes ?? []).map((d) => d.settlementId));
      const candidate = settlements
        .filter((s) => s.status === "completed" && s.chargedCents > 0 && !disputed.has(s.id))
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!candidate) {
        toast({
          tone: "warning",
          title: settlements.some((s) => s.status === "completed") ? "Every settled tab already has a dispute" : "No settled tab to dispute yet",
          description: "Disputes are opened on a tab's one PayPal charge. Close a tab in the console first.",
        });
        return;
      }
      const result = await api.disputes.simulate({ settlementId: candidate.id });
      const tab = docket.tabs.get(candidate.tabId);
      toast({
        title: "The buyer disputed a charge",
        description: `${formatCents(candidate.chargedCents)} on ${tab?.label || "a settled tab"}. The jury is hearing it now.`,
      });
      if (isDispute(result)) {
        docket.applyDispute(result);
        reveal({ kind: "dispute", id: result.id, at: result.createdAt, dispute: result }, filter === "all" || filter === "disputes" || filter === "open");
      } else {
        await docket.reload();
      }
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't simulate a dispute") });
    } finally {
      setBusy(null);
    }
  }

  function summarize(c: JuryCase): CaseSummary {
    if (c.kind === "review") {
      const { review } = c;
      const tab = docket.tabs.get(review.tabId);
      const alarm = review.alarmId ? docket.alarms.get(review.alarmId) : undefined;
      const outcome = reviewOutcome(review);
      const pct = confidencePct(review.confidence);
      return {
        kind: "review",
        eyebrow: alarm ? `Rogue agent · ${ALARM_HEADLINE[alarm.kind] ?? alarm.kind}` : "Rogue agent",
        title: (
          <>
            {tab?.companyName ?? tab?.companyId ?? "Unknown company"} <span className="jy-sep">·</span> {tab?.label || "Untitled tab"}
          </>
        ),
        line: alarm?.message ?? review.reason ?? "Paused for review.",
        badge: REVIEW_OUTCOME[outcome],
        live: outcome === "hearing",
        meta: review.fault || pct != null ? [review.fault ? FAULT_LABEL[review.fault] : null, pct != null ? `${pct}% sure` : null].filter(Boolean).join(" · ") : undefined,
      };
    }
    const { dispute } = c;
    const tab = dispute.tabId ? docket.tabs.get(dispute.tabId) : undefined;
    const jury = dispute.jury;
    const pct = confidencePct(jury?.confidence);
    const due = dispute.status !== "RESOLVED" && dispute.sellerResponseDueAt ? ` · respond by ${formatDate(dispute.sellerResponseDueAt)}` : "";
    return {
      kind: "dispute",
      eyebrow: `PayPal dispute · ${disputeReasonLabel(dispute.reason)}`,
      title: (
        <>
          {tab?.companyName ?? dispute.companyId ?? "Unknown company"} <span className="jy-sep">·</span> {tab?.label || "Untitled tab"}
        </>
      ),
      line: `${formatCents(dispute.amountCents)} disputed${due}`,
      badge: disputeBadge(dispute),
      live: jury?.status === "running",
      meta: !jury
        ? "Not heard yet"
        : jury.status === "running"
          ? "Jury in session"
          : jury.recommendation
            ? `Jury: ${RECOMMENDATION[jury.recommendation].short.toLowerCase()}${pct != null ? ` · ${pct}% sure` : ""}`
            : "No recommendation",
    };
  }

  const loaded = docket.reviews !== undefined;

  return (
    <div className="jy">
      <PageHeader
        eyebrow="AI jury"
        title="Every case the jury has heard"
        description="When an agent goes rogue, a prosecutor, a defender and a judge argue over its spending before anyone pays. When a company disputes a charge on PayPal, the same jury drafts the response."
        actions={
          <>
            {mock ? (
              <Button onClick={simulate} loading={busy === "simulate"} disabled={Boolean(busy) || !docket.disputesReady} title="Mock mode: a buyer disputes the newest settled tab's charge">
                Simulate a dispute
              </Button>
            ) : null}
            <Button onClick={sync} loading={busy === "sync"} disabled={Boolean(busy)}>
              Sync with PayPal
            </Button>
          </>
        }
      />

      {docket.error && !loaded ? (
        <Card>
          <ErrorState error={docket.error} onRetry={docket.reload} />
        </Card>
      ) : !loaded ? (
        <>
          <div className="ui-card jy-record" aria-hidden="true">
            <Skeleton width={120} height={12} />
            <Skeleton height={28} style={{ marginTop: 16 }} />
          </div>
          <DocketSkeleton />
        </>
      ) : (
        <>
          {cases.length ? <Record cases={cases} tabs={docket.tabs} onPick={pick} /> : null}

          {!docket.disputesReady ? (
            <Callout className="jy-notice" title="PayPal disputes aren't connected yet">
              {docket.disputesError
                ? describeError(docket.disputesError, "Couldn't load disputes").description
                : "The rogue-agent cases are all here. Disputes on a tab's charge appear as soon as the gateway's dispute service is running."}
            </Callout>
          ) : null}

          <div className="jy-toolbar">
            <Chips value={filter} counts={counts} onChange={setFilter} />
            {docket.loading ? <span className="jy-refreshing">Refreshing…</span> : null}
          </div>

          {visible.length === 0 ? (
            <Card>
              <EmptyState
                title={EMPTY[filter].title}
                description={EMPTY[filter].description}
                action={
                  filter === "disputes" && mock && docket.disputesReady ? (
                    <Button onClick={simulate} loading={busy === "simulate"} disabled={Boolean(busy)}>
                      Simulate a dispute
                    </Button>
                  ) : filter === "all" || filter === "rogue" ? (
                    <Link to="/console" className={buttonClassName({ variant: "secondary" })}>
                      Open the console
                    </Link>
                  ) : undefined
                }
              />
            </Card>
          ) : (
            <ol className="jy-docket" aria-label="Cases, newest first">
              {visible.map((c) => (
                <li key={`${c.kind}-${c.id}`}>
                  <CaseRow id={c.id} at={c.at} open={openIds.has(c.id)} onToggle={() => toggle(c.id)} summary={summarize(c)}>
                    {c.kind === "review" ? (
                      <ReviewCase
                        review={c.review}
                        tab={docket.tabs.get(c.review.tabId)}
                        alarm={c.review.alarmId ? docket.alarms.get(c.review.alarmId) : undefined}
                        tabs={docket.tabs}
                        onDecided={(review) => {
                          docket.applyReview(review);
                          void docket.reload();
                        }}
                      />
                    ) : (
                      <DisputeCase dispute={c.dispute} tab={c.dispute.tabId ? docket.tabs.get(c.dispute.tabId) : undefined} onUpdate={docket.applyDispute} />
                    )}
                  </CaseRow>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
