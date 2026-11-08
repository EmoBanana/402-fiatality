/**
 * A chart in a card, with a table twin one click away (every value stays reachable without hovering).
 *   <ChartCard title="Voids by reason" subtitle="…" table={<Table …/>} empty={rows.length === 0 && <EmptyState …/>}>
 *     <AgCharts options={…} />
 *   </ChartCard>
 */
import { type ReactNode, useState } from "react";
import { Card, Segmented, type SegmentedOption } from "../../../components";

type View = "chart" | "table";

const VIEWS: Array<SegmentedOption<View>> = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];

export interface ChartCardProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** The same numbers as a table. */
  table: ReactNode;
  /** Replaces chart and table when there is nothing to show. */
  empty?: ReactNode;
  /** Plot height in px, axis band included. */
  height?: number;
  /** Hold the previous render, dimmed, while new data loads. */
  stale?: boolean;
  children: ReactNode;
}

export function ChartCard({ title, subtitle, table, empty, height = 300, stale = false, children }: ChartCardProps) {
  const [view, setView] = useState<View>("chart");
  const hasEmpty = empty !== undefined && empty !== null && empty !== false;
  return (
    <Card
      className="ins-chart-card"
      title={title}
      subtitle={subtitle}
      actions={hasEmpty ? undefined : <Segmented label="Show as" hideLabel value={view} options={VIEWS} onChange={setView} />}
    >
      {hasEmpty ? (
        <div className="ins-chart-empty" style={{ minHeight: height }}>
          {empty}
        </div>
      ) : view === "chart" ? (
        <div className="ins-chart" style={{ height }} data-stale={stale || undefined}>
          {children}
        </div>
      ) : (
        <div className="ins-chart-table" style={{ maxHeight: height }}>
          {table}
        </div>
      )}
    </Card>
  );
}
