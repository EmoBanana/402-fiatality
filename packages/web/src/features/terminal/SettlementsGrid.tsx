/**
 * Settlements: one row per PayPal capture (a closed tab), batched fee versus what per-call payments would
 * have cost, and a master/detail grid with each seller's line (gross, pro-rata fee share, net).
 */
import type { SettlementDTO, SettlementLineDTO } from "@p402/shared";
import type { ColDef, GetRowIdParams, GridApi, ProcessCellForExportParams, Toolbar } from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { useMemo } from "react";
import { formatCount, formatDateTime, formatPct, shortId } from "../../lib/format";
import { useGridTheme } from "./agGrid";
import { CentsCell, MoneyCell, StatusBadgeCell } from "./cells";
import { centsToDollarsText, EXCEL_STYLES, fileStamp, localIso, microsToDollarsText } from "./exporting";
import { numericValue, SETTLEMENT_STATUS } from "./labels";
import { useTerminal } from "./store";

const MICROS_COLS = new Set(["billableMicros", "carryOutMicros", "voidedMicros", "grossMicros", "feeShareMicros", "netMicros"]);
const CENTS_COLS = new Set(["chargedCents", "paypalFeeCents", "naiveFeeCents", "savedCents"]);

function exportCell(p: ProcessCellForExportParams): string {
  const colId = p.column.getColId();
  const n = numericValue(p.value);
  if (colId === "createdAt") return typeof p.value === "number" ? localIso(p.value) : p.node?.footer ? "Total" : "";
  if (MICROS_COLS.has(colId)) return n == null ? "" : microsToDollarsText(n);
  if (CENTS_COLS.has(colId)) return n == null ? "" : centsToDollarsText(n);
  if (colId === "feeRate") return n == null ? "" : String(n);
  if (colId === "status") return typeof p.value === "string" ? (SETTLEMENT_STATUS[p.value as SettlementDTO["status"]]?.label ?? p.value) : "";
  return p.value == null ? "" : String(p.value);
}

function TotalCell() {
  return <span className="tx-group-total">Total</span>;
}

function SettlementStatusCell(props: CustomCellRendererProps<SettlementDTO>) {
  return <StatusBadgeCell value={props.value} map={SETTLEMENT_STATUS} />;
}

// A column-level cellClass replaces the rightAligned type's own class, so numeric columns list it again.
const RIGHT = "ag-right-aligned-cell";
const money = { type: "rightAligned", cellRenderer: MoneyCell, cellClass: [RIGHT, "tx-money"], aggFunc: "sum" } satisfies ColDef;
const cents = { type: "rightAligned", cellRenderer: CentsCell, cellClass: [RIGHT, "tx-money"], aggFunc: "sum" } satisfies ColDef;
const count = {
  type: "rightAligned",
  cellClass: [RIGHT, "tx-mono"],
  aggFunc: "sum",
  valueFormatter: (p: { value: unknown }) => {
    const n = numericValue(p.value);
    return n == null ? "" : formatCount(n);
  },
} satisfies ColDef;

const lineColumns: ColDef<SettlementLineDTO>[] = [
  { field: "sellerName", headerName: "Seller", flex: 1, minWidth: 140, valueGetter: (p) => p.data?.sellerName ?? p.data?.sellerId },
  { field: "calls", headerName: "Calls", width: 100, ...count },
  { field: "grossMicros", headerName: "Gross", width: 130, ...money, headerTooltip: "Billable calls to this seller" },
  { field: "feeShareMicros", headerName: "PayPal fee share", width: 150, ...money, headerTooltip: "The capture fee split pro rata by gross" },
  { field: "netMicros", headerName: "Net to seller", width: 140, ...money, headerTooltip: "Credited to the seller's balance for the weekly payout" },
  {
    colId: "keeps",
    headerName: "Seller keeps",
    width: 120,
    type: "rightAligned",
    cellClass: [RIGHT, "tx-mono"],
    valueGetter: (p) => (p.data && p.data.grossMicros > 0 ? p.data.netMicros / p.data.grossMicros : null),
    valueFormatter: (p) => (typeof p.value === "number" ? formatPct(p.value * 100, 1) : ""),
  },
];

const toolbar: Toolbar = {
  items: [
    { toolbarItem: "agQuickFilterToolbarItem" },
    {
      toolbarItem: "agMenuToolbarItem",
      label: "Export",
      icon: "save",
      tooltip: "Download settlements as CSV or Excel",
      alignment: "right",
      toolbarItemParams: { menuItems: ["csvExport", "excelExport"] },
    },
  ],
};

const getRowId = (p: GetRowIdParams<SettlementDTO>) => p.data.id;
const isRowMaster = (s: SettlementDTO | undefined) => Boolean(s && s.lines.length > 0);

export function SettlementsGrid({ onApi }: { onApi: (api: GridApi<SettlementDTO> | null) => void }) {
  const settlements = useTerminal((s) => s.settlements);
  const phase = useTerminal((s) => s.phase);
  const baseTheme = useGridTheme();
  // Detail grids inherit the master's theme; autoHeight detail grids then hug their rows.
  const theme = useMemo(() => baseTheme.withParams({ autoHeightMinBodyHeight: 0 }), [baseTheme]);

  const columnDefs = useMemo<ColDef<SettlementDTO>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Settled",
        width: 158,
        sort: "desc",
        cellRendererSelector: (p) => (p.node.footer ? { component: TotalCell } : { component: "agGroupCellRenderer" }),
        cellClass: (p) => (p.node?.footer ? "tx-mono" : ["tx-time", "tx-mono"]),
        valueFormatter: (p) => (typeof p.value === "number" ? formatDateTime(p.value) : ""),
      },
      { field: "tabId", headerName: "Tab", width: 112, cellClass: "tx-mono", valueFormatter: (p) => (p.value ? shortId(p.value) : ""), tooltip: (p) => p.value },
      { field: "callCount", headerName: "Calls", width: 84, ...count },
      { field: "billableMicros", headerName: "Billable", width: 104, ...money },
      { field: "chargedCents", headerName: "Charged", width: 100, ...cents, headerTooltip: "The one PayPal capture (billable floored to the cent)" },
      { field: "paypalFeeCents", headerName: "PayPal fee", width: 112, ...cents },
      { field: "naiveFeeCents", headerName: "Per-call fees", width: 120, ...cents, headerTooltip: "Fees if every call had been its own PayPal payment" },
      {
        colId: "savedCents",
        headerName: "Saved",
        width: 108,
        ...cents,
        cellClass: [RIGHT, "tx-money", "tx-saved"],
        headerTooltip: "Per-call fees minus the one batched fee",
        valueGetter: (p) => (p.data ? Math.max(0, p.data.naiveFeeCents - p.data.paypalFeeCents) : undefined),
      },
      {
        colId: "feeRate",
        headerName: "Fee rate",
        width: 100,
        type: "rightAligned",
        cellClass: [RIGHT, "tx-mono", "tx-pct"],
        headerTooltip: "PayPal fee as a share of the charge",
        valueGetter: (p) => (p.data && p.data.chargedCents > 0 ? p.data.paypalFeeCents / p.data.chargedCents : null),
        valueFormatter: (p) => (typeof p.value === "number" ? formatPct(p.value * 100) : ""),
      },
      { field: "status", headerName: "Status", width: 104, cellRenderer: SettlementStatusCell, filter: "agSetColumnFilter" },
      { field: "voidCount", headerName: "Voids", width: 80, ...count },
      { field: "carryOutMicros", headerName: "Carried over", width: 116, ...money, aggFunc: undefined, headerTooltip: "Sub-cent remainder rolled into the next tab" },
      { field: "captureId", headerName: "PayPal capture", flex: 1, minWidth: 150, cellClass: "tx-mono", tooltip: (p) => p.value },
    ],
    [],
  );

  const detailCellRendererParams = useMemo(
    () => ({
      detailGridOptions: {
        columnDefs: lineColumns,
        defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true },
        domLayout: "autoHeight",
        headerHeight: 34,
        rowHeight: 34,
        suppressCellFocus: true,
        getRowId: (p: GetRowIdParams<SettlementLineDTO>) => p.data.sellerId,
      },
      getDetailRowData: (p: { data: SettlementDTO; successCallback: (rows: SettlementLineDTO[]) => void }) => p.successCallback(p.data.lines),
    }),
    [theme],
  );

  return (
    <div className="tx-grid">
      <AgGridReact<SettlementDTO>
        theme={theme}
        rowData={settlements as SettlementDTO[]}
        columnDefs={columnDefs}
        defaultColDef={{ sortable: true, resizable: true, filter: true, suppressHeaderFilterButton: true }}
        suppressMenuHide={false}
        getRowId={getRowId}
        loading={phase === "loading"}
        onGridReady={(e) => onApi(e.api)}
        onGridPreDestroyed={() => onApi(null)}
        masterDetail
        isRowMaster={isRowMaster}
        detailCellRendererParams={detailCellRendererParams}
        detailRowAutoHeight
        grandTotalRow="pinnedBottom"
        suppressAggFuncInHeader
        toolbar={toolbar}
        cellSelection
        tooltipShowDelay={350}
        overlayComponentParams={{
          noRows: { overlayText: "No settlements yet. Closing a tab makes one PayPal capture and splits the fee across its sellers." },
        }}
        defaultCsvExportParams={{ fileName: `402-fiatality-settlements-${fileStamp()}.csv`, processCellCallback: exportCell }}
        defaultExcelExportParams={{ fileName: `402-fiatality-settlements-${fileStamp()}.xlsx`, sheetName: "Settlements", processCellCallback: exportCell }}
        excelStyles={EXCEL_STYLES}
      />
    </div>
  );
}
