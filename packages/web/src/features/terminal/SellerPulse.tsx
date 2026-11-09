/**
 * Seller pulse: one row per seller with an AG Grid sparkline of billable spend per minute over the last hour,
 * spend in that hour, lifetime billable and void rate. Single hue per the dataviz rules (each row is its own
 * small multiple, the seller name carries identity); the canvas reads resolved token colors.
 */
import type { AgSparklineOptions } from "ag-charts-community";
import type { ColDef, GetRowIdParams } from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { useMemo } from "react";
import { Money } from "../../components";
import { formatPct, formatUsd } from "../../lib/format";
import { useGridTheme, useTokenColors } from "./agGrid";
import type { SellerPulseRow } from "./store";
import { useTerminal } from "./store";

function SellerCell(props: CustomCellRendererProps<SellerPulseRow>) {
  const row = props.data;
  if (!row) return null;
  const rate = row.calls > 0 ? row.voids / row.calls : null;
  return (
    <span className="tx-seller" title={`${row.sellerId}: ${row.voids} of ${row.calls} calls voided`}>
      <span className="tx-seller-name">{row.name}</span>
      <span className="tx-seller-id">
        {rate != null ? <span className={rate >= 0.1 ? "tx-void-high" : undefined}>{formatPct(rate * 100, 0)} voided</span> : row.sellerId}
      </span>
    </span>
  );
}

function MicrosCell(props: CustomCellRendererProps<SellerPulseRow>) {
  // padTo lines the column up on the decimal point ($0.03 next to $0.036).
  return typeof props.value === "number" ? <Money micros={props.value} padTo={3} /> : null;
}

const getRowId = (p: GetRowIdParams<SellerPulseRow>) => p.data.sellerId;

export function SellerPulse() {
  const rows = useTerminal((s) => s.pulse);
  const phase = useTerminal((s) => s.phase);
  const theme = useGridTheme();
  const colors = useTokenColors();

  const columnDefs = useMemo<ColDef<SellerPulseRow>[]>(() => {
    const sparklineOptions: AgSparklineOptions = {
      type: "area",
      fill: colors.accent,
      fillOpacity: 0.12,
      stroke: colors.accent,
      strokeWidth: 1.5,
      marker: { enabled: false },
      axis: { visible: false },
      min: 0,
      tooltip: {
        renderer: ({ yValue, xValue }) => {
          const minutesAgo = 59 - Number(xValue);
          return {
            title: minutesAgo === 0 ? "This minute" : `${minutesAgo} min ago`,
            content: `${formatUsd(Math.round(Number(yValue) * 1_000_000))} billable`,
          };
        },
      },
    };
    return [
      { field: "name", headerName: "Seller", flex: 1.4, minWidth: 140, cellRenderer: SellerCell },
      {
        colId: "series",
        field: "series",
        headerName: "Trend",
        headerTooltip: "Billable spend per minute, last 60 minutes",
        flex: 1,
        minWidth: 84,
        sortable: false,
        cellRenderer: "agSparklineCellRenderer",
        cellRendererParams: { sparklineOptions },
      },
      {
        field: "spend60Micros",
        headerName: "60 min",
        headerTooltip: "Billable in the last hour",
        width: 92,
        type: "rightAligned",
        sort: "desc",
        cellRenderer: MicrosCell,
      },
    ];
  }, [colors]);

  return (
    <div className="tx-pulse-grid">
      <AgGridReact<SellerPulseRow>
        theme={theme}
        rowData={rows as SellerPulseRow[]}
        columnDefs={columnDefs}
        getRowId={getRowId}
        defaultColDef={{ suppressHeaderMenuButton: true, suppressHeaderFilterButton: true, resizable: false, suppressMovable: true }}
        loading={phase === "loading"}
        domLayout="autoHeight"
        rowHeight={46}
        headerHeight={34}
        suppressCellFocus
        tooltipShowDelay={300}
        overlayComponentParams={{ noRows: { overlayText: "No sellers yet" } }}
      />
    </div>
  );
}
