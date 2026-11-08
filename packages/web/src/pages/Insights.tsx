/**
 * Insights: where agent money went. Two AG Charts sections (spend and voids for a chosen range; fees across
 * every settled tab) and an AG Studio explorer over the same ledger with Gemma as its AI assistant.
 * Everything stays live through the gateway's event stream.
 */
import type { AgStudioMode } from "ag-studio";
import { lazy, Suspense, useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge, buttonClassName, Card, EmptyState, ErrorState, Money, PageHeader, Segmented, type SegmentedOption, Spinner, Stat } from "../components";
import { ChartCard } from "../features/insights/charts/ChartCard";
import { FeeRateChart, FeeRateTable, NaiveVsBatchedChart, NaiveVsBatchedTable } from "../features/insights/charts/FeeCharts";
import { SpendChart, SpendTable } from "../features/insights/charts/SpendChart";
import { VoidsChart, VoidsTable } from "../features/insights/charts/VoidsChart";
import { KpiStrip } from "../features/insights/KpiStrip";
import {
  feeTotals,
  RANGES,
  type RangeId,
  rangeOption,
  savingsMultiple,
  sellerNames,
  sellerOrder,
  settledTabs,
  spendRows,
  spendTotals,
  voidsByReason,
} from "../features/insights/metrics";
import { useAiStatus } from "../features/insights/studio/gemmaAdapter";
import { useTokens } from "../features/insights/tokens";
import { useInsightsData } from "../features/insights/useInsightsData";
import "../features/insights/insights.css";
import { useGatewayClock } from "../features/timeline/useGatewayClock";
import { formatCount, formatPct, modelLabel } from "../lib/format";

const InsightsStudio = lazy(() => import("../features/insights/studio/InsightsStudio"));

const RANGE_OPTIONS: Array<SegmentedOption<RangeId>> = RANGES.map((r) => ({ value: r.id, label: r.label }));
const MODE_OPTIONS: Array<SegmentedOption<AgStudioMode>> = [
  { value: "view", label: "View" },
  { value: "edit", label: "Edit + AI", title: "Edit the dashboard and open the AI assistant" },
];
/** Categorical slots available; sellers past this fold into "Other". */
const MAX_SERIES = 6;
const OTHER = "__other";

export default function Insights() {
  const tokens = useTokens();
  const clock = useGatewayClock(30_000);
  const [rangeId, setRangeId] = useState<RangeId>("1h");
  const [studioMode, setStudioMode] = useState<AgStudioMode>("edit");
  const range = rangeOption(rangeId);
  const data = useInsightsData(rangeId, clock.now);
  const ai = useAiStatus();

  const names = useMemo(() => sellerNames(data.sellers), [data.sellers]);
  const tabsById = useMemo(() => new Map(data.tabs.map((t) => [t.id, t])), [data.tabs]);

  // Seller → color slot, by seller id (stable across ranges and filters). Past six sellers, fold the rest.
  const { seriesIds, seriesNames, colors, points } = useMemo(() => {
    const seen = new Set<string>();
    for (const p of data.points) for (const id of Object.keys(p.bySeller)) seen.add(id);
    const order = sellerOrder(data.sellers, seen);
    const kept = order.length > MAX_SERIES ? order.slice(0, MAX_SERIES - 1) : order;
    const folded = new Set(order.slice(kept.length));
    const ids = folded.size > 0 ? [...kept, OTHER] : kept;
    const nameMap = new Map(ids.map((id) => [id, id === OTHER ? "Other sellers" : (names.get(id) ?? id)]));
    const colorMap = new Map(ids.map((id, i) => [id, tokens.series[i % tokens.series.length] ?? tokens.accent]));
    const pts =
      folded.size === 0
        ? data.points
        : data.points.map((p) => {
            const bySeller: Record<string, number> = {};
            for (const [id, micros] of Object.entries(p.bySeller)) {
              const key = folded.has(id) ? OTHER : id;
              bySeller[key] = (bySeller[key] ?? 0) + micros;
            }
            return { ...p, bySeller };
          });
    return { seriesIds: ids, seriesNames: nameMap, colors: colorMap, points: pts };
  }, [data.points, data.sellers, names, tokens]);

  const rows = useMemo(() => spendRows(points, seriesIds, range), [points, seriesIds, range]);
  const totals = useMemo(() => spendTotals(data.points), [data.points]);
  const since = data.points[0]?.t ?? clock.now - range.minutes * 60_000;
  const voids = useMemo(() => voidsByReason(data.vouchers, since), [data.vouchers, since]);
  const voidedMicros = voids.reduce((s, r) => s + r.micros, 0);
  const settled = useMemo(() => settledTabs(data.settlements, tabsById), [data.settlements, tabsById]);
  const fees = useMemo(() => feeTotals(settled), [settled]);
  const studioSnapshot = useMemo(
    () => ({ vouchers: data.vouchers, settlements: data.settlements, sellers: data.sellers, tabs: data.tabs, spend: data.points }),
    [data.vouchers, data.settlements, data.sellers, data.tabs, data.points],
  );

  const accepted = Math.max(0, totals.calls - totals.voids);
  const topSeller = Object.entries(totals.bySeller).sort((a, b) => b[1] - a[1])[0];
  const paidCalls = settled.reduce((s, p) => s + p.calls, 0);
  const multiple = savingsMultiple(fees.naiveFeeCents, fees.feeCents);
  const llm = data.config?.llm;
  const aiLabel = !llm ? "AI · Gemma" : llm.provider === "mock" ? "AI · mock LLM" : `AI · ${modelLabel(ai.state === "ok" ? ai.model : llm.model)}`;

  if (data.status === "loading") {
    return (
      <div className="ins-page">
        <Header />
        <div className="ins-loading">
          <Spinner size={20} label="Loading insights" />
        </div>
      </div>
    );
  }

  if (data.status === "error" && data.error) {
    return (
      <div className="ins-page">
        <Header />
        <Card>
          <ErrorState error={data.error} onRetry={data.reload} />
        </Card>
      </div>
    );
  }

  const spendSubtitle = `Billable spend per ${range.bucketSec >= 3600 ? `${range.bucketSec / 3600} h` : `${range.bucketSec / 60} min`}, stacked by seller${
    data.pointsSource === "local" ? " · rebuilt from the latest calls" : ""
  }`;

  return (
    <div className="ins-page">
      <Header />

      <section className="ins-section" aria-labelledby="ins-spend">
        <div className="ins-section-head">
          <div>
            <h2 id="ins-spend">Spend</h2>
            <p>Paid calls, by seller, as the agents make them.</p>
          </div>
          <Segmented label="Time range" hideLabel value={rangeId} options={RANGE_OPTIONS} onChange={setRangeId} />
        </div>
        <KpiStrip label="Spend in range">
          <Stat label="Billable" value={<Money micros={totals.spendMicros} />} hint={`${formatCount(accepted)} accepted calls`} />
          <Stat
            label="Voided"
            value={formatCount(totals.voids)}
            hint={totals.calls > 0 ? `${formatPct((totals.voids / totals.calls) * 100, 1)} of calls · never billed` : "No calls yet"}
          />
          <Stat
            label="Not billed"
            value={<Money micros={voidedMicros} />}
            hint={data.capped ? "Latest 1,000 calls" : "List price of voided calls"}
          />
          <Stat
            label="Top seller"
            value={<span className="ins-kpi-text">{topSeller ? (names.get(topSeller[0]) ?? topSeller[0]) : "None yet"}</span>}
            hint={topSeller && totals.spendMicros > 0 ? `${formatPct((topSeller[1] / totals.spendMicros) * 100, 0)} of billable spend` : "Waiting for paid calls"}
          />
        </KpiStrip>
        <div className="ins-grid">
          <ChartCard
            title="Spend over time, by seller"
            subtitle={spendSubtitle}
            stale={data.refreshing}
            table={<SpendTable rows={rows} sellerIds={seriesIds} names={seriesNames} />}
            empty={
              totals.calls === 0 ? (
                <EmptyState
                  title={`No paid calls in the ${range.label.toLowerCase()}`}
                  description="Run an agent from the console and spend appears here as it happens."
                  action={
                    <Link className={buttonClassName({ variant: "secondary", size: "sm" })} to="/console">
                      Open console
                    </Link>
                  }
                />
              ) : undefined
            }
          >
            <SpendChart rows={rows} sellerIds={seriesIds} names={seriesNames} colors={colors} range={range} tokens={tokens} />
          </ChartCard>
          <ChartCard
            title="Voided calls, by reason"
            subtitle="Calls that broke a seller's void rules or failed AI review, so nobody paid for them"
            table={<VoidsTable rows={voids} />}
            empty={
              voids.length === 0 ? (
                <EmptyState title="No voided calls" description="Every call in this range was billable." />
              ) : undefined
            }
          >
            <VoidsChart rows={voids} tokens={tokens} />
          </ChartCard>
        </div>
      </section>

      <section className="ins-section" aria-labelledby="ins-fees">
        <div className="ins-section-head">
          <div>
            <h2 id="ins-fees">Fees</h2>
            <p>Every settled tab: one PayPal charge instead of a payment per call.</p>
          </div>
        </div>
        <KpiStrip label="Fees across settled tabs">
          <Stat label="Charged on PayPal" value={<Money cents={fees.chargedCents} />} hint={`${formatCount(fees.tabs)} settled ${fees.tabs === 1 ? "tab" : "tabs"}`} />
          <Stat label="PayPal fees" value={<Money cents={fees.feeCents} />} hint={fees.chargedCents > 0 ? `${formatPct(fees.ratePct)} effective rate` : "Nothing settled yet"} />
          <Stat
            label="Fee per paid call"
            value={<Money micros={paidCalls > 0 ? Math.round((fees.feeCents * 10_000) / paidCalls) : 0} />}
            hint="vs at least $0.49 as separate payments"
          />
          <Stat
            label="Per-call fees avoided"
            tone={fees.savedCents > 0 ? "success" : "default"}
            value={<Money cents={fees.savedCents} />}
            hint={multiple ? `Batching was ${multiple} cheaper` : "Settle a tab to compare"}
          />
        </KpiStrip>
        <div className="ins-grid">
          <ChartCard
            title="Effective fee rate by tab size"
            subtitle="PayPal Checkout's 3.49% + $0.49 on one charge, with every settled tab"
            table={<FeeRateTable points={settled} />}
          >
            <FeeRateChart points={settled} tokens={tokens} />
          </ChartCard>
          <ChartCard
            title="Per-call vs batched PayPal fees"
            subtitle="Fees if each paid call were its own PayPal payment, against the tab's one charge"
            table={<NaiveVsBatchedTable points={settled} />}
            empty={
              settled.length === 0 ? (
                <EmptyState title="No settled tabs yet" description="Close a tab from the console to see its one charge against per-call fees." />
              ) : undefined
            }
          >
            <NaiveVsBatchedChart points={settled} tokens={tokens} />
          </ChartCard>
        </div>
      </section>

      <section className="ins-section" aria-labelledby="ins-explore">
        <Card
          className="ins-studio-card"
          padding="none"
          title={<span id="ins-explore">Explore the ledger</span>}
          subtitle="AG Studio over the same calls, tabs and settlements. Drag fields onto the canvas, or ask Gemma in the AI panel."
          actions={
            <div className="ins-studio-actions">
              {ai.state === "offline" ? (
                <Badge tone="warning" dot title={ai.message}>
                  AI unavailable
                </Badge>
              ) : (
                <Badge tone="accent" title="The AI panel runs on the gateway's /api/ai/chat">
                  {aiLabel}
                </Badge>
              )}
              <Segmented label="Studio mode" hideLabel value={studioMode} options={MODE_OPTIONS} onChange={setStudioMode} />
            </div>
          }
        >
          {ai.state === "offline" ? (
            <p className="ins-studio-note" role="status">
              {ai.message} Dashboards and drag-and-drop still work.
            </p>
          ) : null}
          <div className="ins-studio">
            <Suspense
              fallback={
                <div className="ins-loading">
                  <Spinner size={20} label="Loading AG Studio" />
                </div>
              }
            >
              <InsightsStudio snapshot={studioSnapshot} tokens={tokens} mode={studioMode} />
            </Suspense>
          </div>
        </Card>
      </section>
    </div>
  );
}

function Header() {
  return (
    <PageHeader
      title="Insights"
      description="Where agent money went: spend by seller, calls nobody paid for, and what one batched PayPal charge saves over per-call payments."
    />
  );
}
