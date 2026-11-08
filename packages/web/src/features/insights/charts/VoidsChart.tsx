/**
 * Voided calls by reason: horizontal bars in one hue (reasons are nominal, so bar length carries the value,
 * not color), count labelled at each bar tip, the unbilled amount in the tooltip and table.
 */
import type { AgCartesianChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useMemo } from "react";
import { Money, Table } from "../../../components";
import { formatCount } from "../../../lib/format";
import type { VoidReasonRow } from "../metrics";
import type { Tokens } from "../tokens";
import { chartTheme, formatDollars } from "./chartTheme";

interface VoidDatum extends VoidReasonRow {
  dollars: number;
}

export function VoidsChart({ rows, tokens }: { rows: VoidReasonRow[]; tokens: Tokens }) {
  const options = useMemo<AgCartesianChartOptions>(() => {
    const data: VoidDatum[] = rows.map((r) => ({ ...r, dollars: r.micros / 1_000_000 }));
    return {
      theme: chartTheme(tokens),
      data,
      series: [
        {
          type: "bar",
          direction: "horizontal",
          xKey: "label",
          yKey: "count",
          yName: "Voided calls",
          fill: tokens.series[0],
          stroke: tokens.series[0],
          strokeWidth: 0,
          cornerRadius: 4,
          label: {
            enabled: true,
            placement: "outside-end",
            color: tokens.ink2,
            fontFamily: tokens.fontMono,
            fontSize: 11,
            formatter: ({ value }: { value: number }) => formatCount(value),
          },
          tooltip: {
            renderer: ({ datum }: { datum: VoidDatum }) => ({
              title: datum.label,
              data: [
                { label: "Voided calls", value: formatCount(datum.count) },
                { label: "Not billed", value: formatDollars(datum.dollars) },
              ],
            }),
          },
        },
      ],
      // Axes are keyed by the series key they bind to: `x` holds the categories (drawn on the left for
      // horizontal bars), `y` the counts.
      axes: {
        x: {
          type: "category",
          position: "left",
          label: { color: tokens.ink2, maxWidth: 150, wrapping: "on-space" },
          line: { enabled: false },
          gridLine: { enabled: false },
          paddingInner: 0.5,
          paddingOuter: 0.25,
        },
        y: {
          type: "number",
          position: "bottom",
          min: 0,
          // Headroom for the count label at the tip of the longest bar.
          max: Math.max(4, Math.ceil(Math.max(0, ...rows.map((r) => r.count)) * 1.15)),
          label: { color: tokens.muted, formatter: ({ value }: { value: number }) => (Number.isInteger(value) ? formatCount(value) : "") },
          gridLine: { style: [{ stroke: tokens.hairline }] },
          line: { enabled: false },
        },
      },
      legend: { enabled: false },
      padding: { right: 16 },
      animation: { enabled: false },
    };
  }, [rows, tokens]);
  return <AgCharts options={options} style={{ height: "100%" }} />;
}

export function VoidsTable({ rows }: { rows: VoidReasonRow[] }) {
  return (
    <Table
      dense
      caption="Voided calls by reason"
      rows={rows}
      rowKey={(r) => r.reason}
      columns={[
        { key: "reason", header: "Reason", render: (r) => r.label },
        { key: "count", header: "Calls", align: "right", render: (r) => <span className="mono">{formatCount(r.count)}</span> },
        { key: "amount", header: "Not billed", align: "right", render: (r) => <Money micros={r.micros} /> },
      ]}
    />
  );
}
