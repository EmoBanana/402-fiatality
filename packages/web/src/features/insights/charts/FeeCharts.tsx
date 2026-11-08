/**
 * Fee views.
 *  - FeeRateChart: PayPal's effective rate for one capture by tab size ($1–$100, from the shared fee math)
 *    with every settled tab plotted on it, and the $50 close threshold marked.
 *  - NaiveVsBatchedChart: per settled tab, what per-call PayPal payments would have cost in fees (context,
 *    gray) against the one batched charge (accent), values labelled at the bar tips.
 */
import type { AgCartesianChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useMemo } from "react";
import { Money, Table } from "../../../components";
import { formatCount, formatDate, formatPct } from "../../../lib/format";
import { type FeeCurvePoint, feeCurve, type SettlementPoint } from "../metrics";
import type { Tokens } from "../tokens";
import { chartTheme, formatDollars, formatDollarTick } from "./chartTheme";

const CLOSE_AT_DOLLARS = 50;

/** Round up to 1, 2, 2.5 or 5 times a power of ten, for a clean axis end. */
function niceCeiling(value: number): number {
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * power >= value) ?? 10;
  return step * power;
}

function truncate(text: string, max = 32): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------- effective rate by tab size

export function FeeRateChart({ points, tokens }: { points: SettlementPoint[]; tokens: Tokens }) {
  const options = useMemo<AgCartesianChartOptions>(() => {
    const maxDollars = Math.max(100, ...points.map((p) => Math.ceil(p.dollars / 10) * 10));
    const curve = feeCurve(maxDollars);
    const atClose = curve.find((p) => p.dollars === CLOSE_AT_DOLLARS);
    const maxRate = Math.max(...curve.map((p) => p.rate), ...points.map((p) => p.rate));
    const rateCeiling = Math.ceil(maxRate / 10) * 10;
    const curveSeries = {
      type: "line" as const,
      data: curve,
      xKey: "dollars",
      yKey: "rate",
      yName: "One PayPal charge (3.49% + $0.49)",
      stroke: tokens.series[0],
      strokeWidth: 2,
      marker: { enabled: false },
      interpolation: { type: "smooth" as const },
      tooltip: {
        renderer: ({ datum }: { datum: FeeCurvePoint }) => ({
          title: `${formatDollars(datum.dollars)} tab`,
          data: [
            { label: "PayPal fee", value: formatDollars(datum.feeCents / 100) },
            { label: "Effective rate", value: formatPct(datum.rate) },
          ],
        }),
      },
    };
    const settledSeries = {
      type: "scatter" as const,
      data: points,
      xKey: "dollars",
      yKey: "rate",
      yName: "Settled tabs",
      fill: tokens.series[1],
      stroke: tokens.surface,
      strokeWidth: 2,
      size: 10,
      tooltip: {
        renderer: ({ datum }: { datum: SettlementPoint }) => ({
          title: datum.label,
          data: [
            { label: "Charged", value: formatDollars(datum.dollars) },
            { label: "PayPal fee", value: formatDollars(datum.feeCents / 100) },
            { label: "Effective rate", value: formatPct(datum.rate) },
            { label: "Paid calls", value: formatCount(datum.calls) },
          ],
        }),
      },
    };
    return {
      theme: chartTheme(tokens),
      // Settled tabs (and their legend entry) appear once one has settled.
      series: points.length > 0 ? [curveSeries, settledSeries] : [curveSeries],
      axes: {
        x: {
          type: "number",
          position: "bottom",
          min: 0,
          max: maxDollars,
          title: { text: "Tab size (one charge)", color: tokens.muted, fontSize: 12 },
          label: { color: tokens.muted, formatter: ({ value }: { value: number }) => formatDollarTick(value) },
          gridLine: { enabled: false },
          line: { stroke: tokens.hairlineStrong },
          crossLines: atClose
            ? [
                {
                  type: "line",
                  value: CLOSE_AT_DOLLARS,
                  stroke: tokens.muted,
                  strokeWidth: 1,
                  lineDash: [3, 4],
                  label: {
                    text: `$50 close · ${formatPct(atClose.rate)}`,
                    placement: "top",
                    color: tokens.ink2,
                    fontSize: 11,
                  },
                },
              ]
            : [],
        },
        y: {
          type: "number",
          position: "left",
          min: 0,
          max: rateCeiling,
          title: { text: "Effective fee rate", color: tokens.muted, fontSize: 12 },
          label: { color: tokens.muted, formatter: ({ value }: { value: number }) => `${value}%` },
          gridLine: { style: [{ stroke: tokens.hairline }] },
          line: { enabled: false },
        },
      },
      legend: { position: "bottom", item: { label: { color: tokens.ink2 } } },
      padding: { top: 20, right: 12 },
      animation: { enabled: false },
    };
  }, [points, tokens]);
  return <AgCharts options={options} style={{ height: "100%" }} />;
}

export function FeeRateTable({ points }: { points: SettlementPoint[] }) {
  const sample = [100, 500, 1_000, 2_000, 5_000, 10_000];
  const curve = feeCurve(100).filter((p) => sample.includes(Math.round(p.dollars * 100)));
  return (
    <div className="ins-table-stack">
      <Table
        dense
        caption="Effective PayPal fee rate by tab size"
        rows={curve}
        rowKey={(p) => String(p.dollars)}
        columns={[
          { key: "size", header: "Tab size", render: (p) => <Money cents={Math.round(p.dollars * 100)} /> },
          { key: "fee", header: "PayPal fee", align: "right", render: (p) => <Money cents={p.feeCents} /> },
          { key: "rate", header: "Rate", align: "right", render: (p) => <span className="mono">{formatPct(p.rate)}</span> },
        ]}
      />
      {points.length > 0 ? (
        <Table
          dense
          caption="Settled tabs"
          rows={[...points].reverse()}
          rowKey={(p) => p.id}
          columns={[
            { key: "tab", header: "Settled tab", render: (p) => p.label },
            { key: "charged", header: "Charged", align: "right", render: (p) => <Money cents={p.chargedCents} /> },
            { key: "fee", header: "PayPal fee", align: "right", render: (p) => <Money cents={p.feeCents} /> },
            { key: "rate", header: "Rate", align: "right", render: (p) => <span className="mono">{formatPct(p.rate)}</span> },
          ]}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- per-call vs batched

interface CompareDatum {
  id: string;
  label: string;
  naive: number;
  batched: number;
  calls: number;
}

const MAX_TABS = 6;

export function NaiveVsBatchedChart({ points, tokens }: { points: SettlementPoint[]; tokens: Tokens }) {
  const options = useMemo<AgCartesianChartOptions>(() => {
    // Newest settled tab first (the first category is drawn at the top).
    const data: CompareDatum[] = points
      .slice(-MAX_TABS)
      .reverse()
      .map((p) => ({ id: p.id, label: truncate(p.label), naive: p.naiveFeeCents / 100, batched: p.feeCents / 100, calls: p.calls }));
    const valueLabel = {
      enabled: true,
      placement: "outside-end" as const,
      color: tokens.ink2,
      fontFamily: tokens.fontMono,
      fontSize: 11,
      formatter: ({ value }: { value: number }) => formatDollars(value),
    };
    const tooltip = {
      renderer: ({ datum }: { datum: CompareDatum }) => ({
        title: datum.label,
        data: [
          { label: "Per-call payments", value: formatDollars(datum.naive) },
          { label: "One batched charge", value: formatDollars(datum.batched) },
          { label: "Paid calls", value: formatCount(datum.calls) },
        ],
      }),
    };
    return {
      theme: chartTheme(tokens),
      data,
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "label",
          yKey: "naive",
          yName: "Per-call PayPal payments",
          fill: tokens.hairlineStrong,
          strokeWidth: 0,
          cornerRadius: 4,
          label: valueLabel,
          tooltip,
        },
        {
          type: "bar",
          direction: "horizontal",
          xKey: "label",
          yKey: "batched",
          yName: "One batched charge",
          fill: tokens.accent,
          strokeWidth: 0,
          cornerRadius: 4,
          label: valueLabel,
          tooltip,
        },
      ],
      axes: {
        x: {
          type: "category",
          position: "left",
          label: { color: tokens.ink2, maxWidth: 140, wrapping: "on-space" },
          line: { enabled: false },
          gridLine: { enabled: false },
          paddingInner: 0.35,
          groupPaddingInner: 0.12,
        },
        y: {
          type: "number",
          position: "bottom",
          min: 0,
          // Headroom so the value label at the tip of the longest bar stays inside the plot.
          max: niceCeiling(Math.max(1, ...data.map((d) => d.naive)) * 1.22),
          label: { color: tokens.muted, formatter: ({ value }: { value: number }) => formatDollarTick(value) },
          gridLine: { style: [{ stroke: tokens.hairline }] },
          line: { enabled: false },
        },
      },
      legend: { position: "bottom", item: { marker: { shape: "square", size: 10 }, label: { color: tokens.ink2 } } },
      padding: { right: 8 },
      animation: { enabled: false },
    };
  }, [points, tokens]);
  return <AgCharts options={options} style={{ height: "100%" }} />;
}

export function NaiveVsBatchedTable({ points }: { points: SettlementPoint[] }) {
  return (
    <Table
      dense
      caption="Per-call versus batched PayPal fees by settled tab"
      rows={[...points].reverse()}
      rowKey={(p) => p.id}
      columns={[
        { key: "tab", header: "Settled tab", render: (p) => p.label },
        { key: "when", header: "Settled", render: (p) => formatDate(p.createdAt) },
        { key: "calls", header: "Paid calls", align: "right", render: (p) => <span className="mono">{formatCount(p.calls)}</span> },
        { key: "naive", header: "Per-call fees", align: "right", render: (p) => <Money cents={p.naiveFeeCents} /> },
        { key: "batched", header: "Batched fee", align: "right", render: (p) => <Money cents={p.feeCents} /> },
      ]}
    />
  );
}
