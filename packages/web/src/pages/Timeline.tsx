/**
 * Timeline: every tab's PayPal hold on one Bryntum schedule — honor windows, the reauthorization (day 4, or
 * day 25 for a small tab), the one charge, and the sellers' weekly payouts — against the gateway's demo
 * clock. In demo mode the planned charge can be dragged (PATCH /api/tabs/:id/schedule) and the clock
 * fast-forwarded a day at a time (POST /api/clock/advance), which runs the gateway's settlement scheduler.
 */
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { Link } from "react-router";
import { Button, buttonClassName, Card, describeError, EmptyState, ErrorState, PageHeader, Spinner, useToast } from "../components";
import { buildTimeline, DAY, ROW_HEIGHT, tabName, validateCharge } from "../features/timeline/buildTimeline";
import type { DropRequest } from "../features/timeline/TabScheduler";
import "../features/timeline/timeline.css";
import { useGatewayClock } from "../features/timeline/useGatewayClock";
import { useTimelineData } from "../features/timeline/useTimelineData";
import { api } from "../lib/api";
import { formatDateTime, formatDuration } from "../lib/format";

const TabScheduler = lazy(() => import("../features/timeline/TabScheduler").then((m) => ({ default: m.TabScheduler })));

/** Two header rows (weeks over days) plus borders. */
const HEADER_HEIGHT = 54;

export default function Timeline() {
  const data = useTimelineData();
  const clock = useGatewayClock(30_000);
  const toast = useToast();
  const [advancing, setAdvancing] = useState(false);
  const demo = Boolean(data.config?.demo);
  const minute = Math.floor(clock.now / 60_000) * 60_000;
  const { tabs, payouts, settlements, putTab, reload } = data;

  const tabsById = useMemo(() => new Map(tabs.map((t) => [t.id, t])), [tabs]);
  const model = useMemo(() => buildTimeline(tabs, payouts, settlements, { now: minute, demo }), [tabs, payouts, settlements, minute, demo]);

  const validateDrop = useCallback((tabId: string, at: number) => validateCharge(tabsById.get(tabId), at, Date.now() + clock.offsetMs), [tabsById, clock.offsetMs]);

  const onDrop = useCallback(
    async ({ tabId, closeAt }: DropRequest) => {
      const tab = tabsById.get(tabId);
      try {
        const updated = await api.tabs.schedule(tabId, { closeAt });
        if (updated?.id) putTab(updated);
        toast({ tone: "success", title: "Charge rescheduled", description: `${tab ? tabName(tab) : "The tab"} now charges ${formatDateTime(closeAt)}.` });
      } catch (err) {
        const { title, description } = describeError(err, "Couldn't reschedule the charge");
        toast({ tone: "danger", title, description });
        throw err;
      }
    },
    [tabsById, putTab, toast],
  );

  const advance = useCallback(async () => {
    setAdvancing(true);
    try {
      const dto = await clock.advance(DAY);
      toast({ title: "A day later", description: `Demo time is now ${formatDateTime(dto.now)}. The gateway ran its settlement scheduler.` });
      // The scheduler's tab.updated events usually arrive first; refetch anyway in case any were missed.
      window.setTimeout(reload, 900);
    } catch (err) {
      const { title, description } = describeError(err, "Couldn't move the clock");
      toast({ tone: "danger", title, description });
    } finally {
      setAdvancing(false);
    }
  }, [clock, reload, toast]);

  const ahead = clock.offsetMs > 60_000;
  const actions = (
    <div className="tl-actions">
      <span className="tl-clock" title={clock.available ? "Gateway clock" : "Browser clock (gateway clock unavailable)"}>
        <span className="tl-clock-label">{demo ? "Demo clock" : "Gateway clock"}{ahead ? ` · ${formatDuration(clock.offsetMs)} ahead` : ""}</span>
        <span className="tl-clock-value">{formatDateTime(clock.now)}</span>
      </span>
      {demo ? (
        <Button variant="secondary" onClick={advance} loading={advancing} title="Fast-forward the demo clock by one day">
          +1 day
        </Button>
      ) : null}
    </div>
  );

  const header = (
    <PageHeader
      title="Timeline"
      description="Each tab's PayPal hold on one schedule: the honor windows, the reauthorization, the one charge, and the sellers' weekly payouts."
      actions={data.status === "ready" ? actions : undefined}
    />
  );

  if (data.status === "loading") {
    return (
      <div className="tl-page">
        {header}
        <Card>
          <div style={{ display: "grid", placeItems: "center", minHeight: 240 }}>
            <Spinner size={20} label="Loading tabs" />
          </div>
        </Card>
      </div>
    );
  }

  if (data.status === "error") {
    return (
      <div className="tl-page">
        {header}
        <Card>
          <ErrorState error={data.error} onRetry={reload} />
        </Card>
      </div>
    );
  }

  if (model.resources.length === 0) {
    return (
      <div className="tl-page">
        {header}
        <Card>
          <EmptyState
            title="No tabs yet"
            description="Open a tab from the console: its hold, renewal and charge appear here as soon as PayPal approves it."
            action={
              <Link className={buttonClassName({ variant: "primary", size: "sm" })} to="/console">
                Open console
              </Link>
            }
          />
        </Card>
      </div>
    );
  }

  const height = model.resources.length * ROW_HEIGHT + HEADER_HEIGHT;

  return (
    <div className="tl-page">
      {header}
      <Card padding="none">
        <div className="tl-legend" aria-label="Legend">
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--window" aria-hidden="true" />
            Honor window (3 days)
          </span>
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--diamond tl-swatch--reauth" aria-hidden="true" />
            Reauthorization
          </span>
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--diamond tl-swatch--charge" aria-hidden="true" />
            Charge
          </span>
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--diamond tl-swatch--payout" aria-hidden="true" />
            Seller payout
          </span>
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--planned" aria-hidden="true" />
            <span className="tl-swatch tl-swatch--diamond tl-swatch--hollow" aria-hidden="true" />
            Planned
          </span>
          <span className="tl-legend-item">
            <span className="tl-swatch tl-swatch--now" aria-hidden="true" />
            Now
          </span>
          <span className="tl-legend-note">{demo ? "Drag a planned charge to reschedule it." : "Rescheduling is available in demo mode."}</span>
        </div>
        <Suspense
          fallback={
            <div style={{ display: "grid", placeItems: "center", height }}>
              <Spinner size={20} label="Loading the scheduler" />
            </div>
          }
        >
          <TabScheduler model={model} now={minute} demo={demo} validateDrop={validateDrop} onDrop={onDrop} height={height} />
        </Suspense>
      </Card>
      <p className="tl-footnote">
        A tab charges once at $50 billable or on day 7. If it is under $10 on day 4 it skips the early renewal: PayPal reauthorizes on day 25
        and the charge moves to day 28, inside the authorization's 29 days.
        {model.hidden > 0 ? ` Showing the ${model.resources.length - 1} most recent tabs.` : ""}
      </p>
    </div>
  );
}
