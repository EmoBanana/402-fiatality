/**
 * Payouts: weekly PayPal payout batches to sellers (Payouts API, $0.25 per item), with each seller's item
 * in a master/detail grid.
 */
import type { PayoutDTO, PayoutItemDTO } from "@p402/shared";
import type { ColDef, GetRowIdParams, GridApi, ProcessCellForExportParams, Toolbar } from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { useMemo } from "react";
import { formatCount, formatDateTime, shortId } from "../../lib/format";
import { useGridTheme } from "./agGrid";
import { CentsCell, StatusBadgeCell } from "./cells";
import { centsToDollarsText, EXCEL_STYLES, fileStamp, localIso } from "./exporting";
import { numericValue, PAYOUT_STATUS } from "./labels";
import { useTerminal } from "./store";

const CENTS_COLS = new Set(["totalCents", "feeCents", "amountCents"]);

function exportCell(p: ProcessCellForExportParams): string {
  const colId = p.column.getColId();
  const n = numericValue(p.value);
  if (colId === "createdAt") return typeof p.value === "number" ? localIso(p.value) : p.node?.footer ? "Total" : "";
  if (CENTS_COLS.has(colId)) return n == null ? "" : centsToDollarsText(n);
  if (colId === "status") return typeof p.value === "string" ? (PAYOUT_STATUS[p.value as PayoutDTO["status"]]?.label ?? p.value) : "";
  return p.value == null ? "" : String(p.value);
}

function TotalCell() {
  return <span className="tx-group-total">Total</span>;
}

function PayoutStatusCell(props: CustomCellRendererProps<PayoutDTO>) {
  return <StatusBadgeCell value={props.value} map={PAYOUT_STATUS} />;
}

function ItemStatusCell(props: CustomCellRendererProps<PayoutItemDTO>) {
  const value = String(props.value ?? "").toLowerCase();
  const key = value === "success" || value === "paid" ? "success" : value === "failed" ? "failed" : value ? "pending" : "";
  return key ? <StatusBadgeCell value={key} map={PAYOUT_STATUS} /> : null;
}

const cents = { type: "rightAligned", cellRenderer: CentsCell, cellClass: "tx-money", aggFunc: "sum" } satisfies ColDef;

const itemColumns: ColDef<PayoutItemDTO>[] = [
  { colId: "seller", headerName: "Seller", flex: 1, minWidth: 140, valueGetter: (p) => p.data?.sellerName ?? p.data?.sellerId },
  { field: "amountCents", headerName: "Paid out", width: 130, ...cents },
  { field: "feeCents", headerName: "Payout fee", width: 120, ...cents },
  { field: "status", headerName: "Status", width: 110, cellRenderer: ItemStatusCell },
  { field: "paypalItemId", headerName: "PayPal item", flex: 1, minWidth: 150, cellClass: "tx-mono" },
];

const toolbar: Toolbar = {
  items: [
    { toolbarItem: "agQuickFilterToolbarItem" },
    {
      toolbarItem: "agMenuToolbarItem",
      label: "Export",
      icon: "save",
      tooltip: "Download payouts as CSV or Excel",
      alignment: "right",
      toolbarItemParams: { menuItems: ["csvExport", "excelExport"] },
    },
  ],
};

const getRowId = (p: GetRowIdParams<PayoutDTO>) => p.data.id;
const isRowMaster = (p: PayoutDTO | undefined) => Boolean(p && p.items.length > 0);

export function PayoutsGrid({ onApi }: { onApi: (api: GridApi<PayoutDTO> | null) => void }) {
  const payouts = useTerminal((s) => s.payouts);
  const phase = useTerminal((s) => s.phase);
  const baseTheme = useGridTheme();
  // Detail grids inherit the master's theme; autoHeight detail grids then hug their rows.
  const theme = useMemo(() => baseTheme.withParams({ autoHeightMinBodyHeight: 0 }), [baseTheme]);

  const columnDefs = useMemo<ColDef<PayoutDTO>[]>(
    () => [
      {
        field: "createdAt",
        headerName: "Paid",
        width: 158,
        sort: "desc",
        cellRendererSelector: (p) => (p.node.footer ? { component: TotalCell } : { component: "agGroupCellRenderer" }),
        cellClass: (p) => (p.node?.footer ? "tx-mono" : ["tx-time", "tx-mono"]),
        valueFormatter: (p) => (typeof p.value === "number" ? formatDateTime(p.value) : ""),
      },
      { field: "id", headerName: "Payout", width: 140, cellClass: "tx-mono", valueFormatter: (p) => (p.value ? shortId(p.value) : ""), tooltip: (p) => p.value },
      { field: "status", headerName: "Status", width: 112, cellRenderer: PayoutStatusCell, filter: "agSetColumnFilter" },
      {
        colId: "sellers",
        headerName: "Sellers",
        width: 96,
        type: "rightAligned",
        cellClass: "tx-mono",
        aggFunc: "sum",
        valueGetter: (p) => p.data?.items.length,
        valueFormatter: (p) => {
          const n = numericValue(p.value);
          return n == null ? "" : formatCount(n);
        },
      },
      { field: "totalCents", headerName: "Paid out", width: 130, ...cents },
      { field: "feeCents", headerName: "Payout fees", width: 124, ...cents, headerTooltip: "PayPal Payouts API: $0.25 per item, deducted from each payout" },
      { field: "paypalBatchId", headerName: "PayPal batch", flex: 1, minWidth: 160, cellClass: "tx-mono", tooltip: (p) => p.value },
      { field: "error", headerName: "Error", flex: 1, minWidth: 140, hide: true },
    ],
    [],
  );

  const detailCellRendererParams = useMemo(
    () => ({
      detailGridOptions: {
        columnDefs: itemColumns,
        defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true, suppressHeaderFilterButton: true },
        domLayout: "autoHeight",
        headerHeight: 34,
        rowHeight: 34,
        suppressCellFocus: true,
        getRowId: (p: GetRowIdParams<PayoutItemDTO>) => p.data.sellerId,
      },
      getDetailRowData: (p: { data: PayoutDTO; successCallback: (rows: PayoutItemDTO[]) => void }) => p.successCallback(p.data.items),
    }),
    [theme],
  );

  return (
    <div className="tx-grid">
      <AgGridReact<PayoutDTO>
        theme={theme}
        rowData={payouts as PayoutDTO[]}
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
        overlayComponentParams={{ noRows: { overlayText: "No payouts yet. Sellers are paid weekly once they're owed $10." } }}
        defaultCsvExportParams={{ fileName: `p402-payouts-${fileStamp()}.csv`, processCellCallback: exportCell }}
        defaultExcelExportParams={{ fileName: `p402-payouts-${fileStamp()}.xlsx`, sheetName: "Payouts", processCellCallback: exportCell }}
        excelStyles={EXCEL_STYLES}
      />
    </div>
  );
}
