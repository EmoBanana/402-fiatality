/**
 * Spend over time, by seller: stacked columns per time bucket, one categorical slot per seller (assigned
 * by seller id, so colors survive filtering), 1 px surface gaps between segments, shared tooltip.
 */
import type { AgCartesianChartOptions } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import { useMemo } from "react";
import { Table, type TableColumn } from "../../../components";
import { formatCount } from "../../../lib/format";
import type { RangeOption, SpendRow } from "../metrics";
import type { Tokens } from "../tokens";
import { chartTheme, formatDollars, formatDollarTick } from "./chartTheme";

export interface SpendChartProps {
  rows: SpendRow[];
  sellerIds: string[];
  names: ReadonlyMap<string, string>;
  colors: ReadonlyMap<string, string>;
  range: RangeOption;
  tokens: Tokens;
}

export function SpendChart({ rows, sellerIds, names, colors, range, tokens }: SpendChartProps) {
  const options = useMemo<AgCartesianChartOptions>(
    () => ({
      theme: chartTheme(tokens),
      data: rows,
      series: sellerIds.map((id) => ({
        type: "bar" as const,
        xKey: "label",
        yKey: id,
        yName: names.get(id) ?? id,
        stacked: true,
        fill: colors.get(id),
        stroke: tokens.surface,
        strokeWidth: 1,
        cornerRadius: 2,
        tooltip: {
          renderer: ({ datum }: { datum: SpendRow }) => ({
            title: names.get(id) ?? id,
            data: [{ label: String(datum.label), value: formatDollars(Number(datum[id] ?? 0)) }],
          }),
        },
      })),
      axes: {
        x: {
          type: "category",
          position: "bottom",
          label: { color: tokens.muted, avoidCollisions: true, minSpacing: 18, autoRotate: false, rotation: 0 },
          line: { stroke: tokens.hairlineStrong },
          gridLine: { enabled: false },
        },
        y: {
          type: "number",
          position: "left",
          nice: true,
          label: { color: tokens.muted, formatter: ({ value }: { value: number }) => formatDollarTick(value) },
          gridLine: { style: [{ stroke: tokens.hairline, lineDash: [] }] },
          line: { enabled: false },
        },
      },
      legend: { position: "bottom", item: { marker: { shape: "square", size: 10 }, label: { color: tokens.ink2 } } },
      tooltip: { mode: "shared" },
      padding: { top: 16, right: 8 },
      animation: { enabled: false },
    }),
    [rows, sellerIds, names, colors, tokens],
  );
  // Rebuilding on range change resets the zoom-free category axis cleanly.
  return <AgCharts key={range.id} options={options} style={{ height: "100%" }} />;
}

export function SpendTable({ rows, sellerIds, names }: Pick<SpendChartProps, "rows" | "sellerIds" | "names">) {
  const nonEmpty = rows.filter((r) => sellerIds.some((id) => Number(r[id] ?? 0) > 0)).reverse();
  const columns: TableColumn<SpendRow>[] = [
    { key: "label", header: "Bucket", render: (r) => String(r.label) },
    ...sellerIds.map<TableColumn<SpendRow>>((id) => ({
      key: id,
      header: names.get(id) ?? id,
      align: "right",
      render: (r) => <span className="mono">{formatDollars(Number(r[id] ?? 0))}</span>,
    })),
    {
      key: "total",
      header: "Total",
      align: "right",
      render: (r) => <span className="mono">{formatDollars(sellerIds.reduce((s, id) => s + Number(r[id] ?? 0), 0))}</span>,
    },
  ];
  return (
    <Table
      dense
      caption={`Spend per bucket, ${formatCount(nonEmpty.length)} buckets with paid calls`}
      rows={nonEmpty}
      rowKey={(r) => String(r.t)}
      columns={columns}
    />
  );
}
