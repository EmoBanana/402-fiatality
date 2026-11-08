/**
 * The live IOU blotter. Rows arrive through LedgerFeed transactions (never React state); this component only
 * configures AG Grid: columns keyed by VoucherDTO field names (what "Ask the ledger" and the AI Toolkit
 * schema refer to), grouping by seller / agent / task with sums, set filters, voided rows tinted with reason
 * pills, cell flash, master/detail review transcripts, the Quick Access Toolbar, side bar and exports.
 */
import { dollarsToMicros, microsToDollarString } from "@p402/shared";
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IFilterOptionDef,
  INumberFilterParams,
  IToolbarItemParams,
  ProcessCellForExportParams,
  ProcessRowGroupForExportParams,
  RowClassRules,
  SideBarDef,
  StatusPanelDef,
  Toolbar,
  ValueFormatterParams,
} from "ag-grid-community";
import { AgGridReact, type CustomCellRendererProps } from "ag-grid-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Segmented } from "../../components";
import { formatCount, formatDateTime, formatTime, shortId } from "../../lib/format";
import { useGridTheme } from "./agGrid";
import { MoneyCell, RequestCell, ReviewCell, StatusCell } from "./cells";
import { EXCEL_STYLES, fileStamp, localIso, microsToDollarsText } from "./exporting";
import type { LedgerFeed } from "./feed";
import { numericValue, ROW_REVIEW, type RowReview, voidReasonLabel } from "./labels";
import { ReviewDetail } from "./ReviewDetail";
import { type TerminalStore, useTerminal, type VoucherRow } from "./store";

const MINUTE = 60_000;

const GROUP_PRESETS = [
  { id: "", label: "Flat" },
  { id: "sellerId", label: "Seller" },
  { id: "agentId", label: "Agent" },
  { id: "taskId", label: "Task" },
] as const;

function relativeOption(store: TerminalStore, displayKey: string, displayName: string, windowMs: number): IFilterOptionDef {
  return {
    displayKey,
    displayName,
    numberOfInputs: 0,
    predicate: (_values: unknown[], cellValue: unknown) => typeof cellValue === "number" && cellValue >= store.now() - windowMs,
  };
}

const dollarFilterParams: INumberFilterParams = {
  filterOptions: ["greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "equals", "inRange"],
  maxNumConditions: 1,
  allowedCharPattern: "\\d\\.\\$,",
  numberParser: (text) => {
    if (text == null || text.trim() === "") return null;
    try {
      return dollarsToMicros(text);
    } catch {
      return null;
    }
  },
  numberFormatter: (value) => (value == null ? null : microsToDollarString(Math.round(value))),
};

const BLANK_LABELS: Record<string, string> = { voidReason: "Not voided", review: "Not reviewed", settlementId: "Open tab" };

/** Display label for a non-empty value of a column. */
function labelOf(store: TerminalStore, colId: string | undefined, value: unknown): string {
  const text = String(value);
  switch (colId) {
    case "sellerId":
      return store.sellerName(text);
    case "taskId":
      return store.taskLabel(text);
    case "agentId":
    case "tabId":
    case "settlementId":
    case "id":
      return shortId(text);
    case "status":
      return text === "accepted" ? "Accepted" : "Voided";
    case "voidReason":
      return voidReasonLabel(text);
    case "review":
      return ROW_REVIEW[text as RowReview]?.label ?? text;
    default:
      return text;
  }
}

const isBlank = (value: unknown) => value == null || value === "";

/** Cell text: blank stays blank (group and total rows have no value for these columns). */
function cellText(store: TerminalStore, colId: string | undefined, value: unknown): string {
  return isBlank(value) ? "" : labelOf(store, colId, value);
}

/** Set filter entries and group keys name the blank bucket. */
function bucketText(store: TerminalStore, colId: string | undefined, value: unknown): string {
  return isBlank(value) ? (BLANK_LABELS[colId ?? ""] ?? "(Blank)") : labelOf(store, colId, value);
}

function TotalCell() {
  return <span className="tx-group-total">Total</span>;
}

function buildColumns(store: TerminalStore): ColDef<VoucherRow>[] {
  const label = (colId: string) => (p: ValueFormatterParams<VoucherRow>) => cellText(store, colId, p.value);
  const setFilter = (colId: string) => ({
    filter: "agSetColumnFilter",
    filterParams: { valueFormatter: (p: ValueFormatterParams) => bucketText(store, colId, p.value) },
  });
  const money = {
    type: "rightAligned",
    cellRenderer: MoneyCell,
    cellClass: "tx-money",
    enableValue: true,
    allowedAggFuncs: ["sum", "avg", "min", "max"],
    filter: "agNumberColumnFilter",
    filterParams: dollarFilterParams,
  } satisfies ColDef<VoucherRow>;

  return [
    {
      colId: "createdAt",
      field: "createdAt",
      headerName: "Time",
      width: 118,
      sort: "desc",
      cellRendererSelector: (p) =>
        p.node.footer && p.api.getRowGroupColumns().length === 0 ? { component: TotalCell } : { component: "agGroupCellRenderer" },
      cellClass: (p) => (p.node?.footer ? "tx-mono" : ["tx-time", "tx-mono"]),
      valueFormatter: (p) => (typeof p.value === "number" ? formatTime(p.value) : ""),
      tooltip: (p) => (typeof p.value === "number" ? formatDateTime(p.value) : undefined),
      filter: "agDateColumnFilter",
      filterParams: {
        filterOptions: [
          relativeOption(store, "last15Minutes", "Last 15 minutes", 15 * MINUTE),
          relativeOption(store, "lastHour", "Last hour", 60 * MINUTE),
          relativeOption(store, "last24Hours", "Last 24 hours", 24 * 60 * MINUTE),
          "greaterThan",
          "lessThan",
          "inRange",
        ],
        maxNumConditions: 1,
        includeTime: true,
        comparator: (filterDate: Date, cellValue: unknown) => {
          if (typeof cellValue !== "number") return -1;
          const t = filterDate.getTime();
          return cellValue < t ? -1 : cellValue > t ? 1 : 0;
        },
      },
    },
    {
      colId: "sellerId",
      field: "sellerId",
      headerName: "Seller",
      width: 134,
      enableRowGroup: true,
      valueFormatter: label("sellerId"),
      ...setFilter("sellerId"),
    },
    {
      colId: "path",
      field: "path",
      headerName: "Request",
      flex: 2,
      minWidth: 150,
      cellRenderer: RequestCell,
      filter: "agTextColumnFilter",
      tooltip: (p) => (p.data ? `${p.data.method} ${p.data.path}` : undefined),
    },
    {
      colId: "status",
      field: "status",
      headerName: "Status",
      width: 160,
      cellRenderer: StatusCell,
      enableRowGroup: true,
      enableCellChangeFlash: true,
      valueFormatter: label("status"),
      tooltip: (p) => (p.data?.status === "voided" ? `Voided: ${voidReasonLabel(p.data.voidReason)} (not billed)` : undefined),
      ...setFilter("status"),
    },
    {
      colId: "voidReason",
      field: "voidReason",
      headerName: "Void reason",
      width: 190,
      hide: true,
      enableRowGroup: true,
      enableCellChangeFlash: true,
      valueFormatter: (p) => (p.value ? voidReasonLabel(p.value) : ""),
      ...setFilter("voidReason"),
    },
    { colId: "priceMicros", field: "priceMicros", headerName: "Price", width: 100, aggFunc: "sum", ...money },
    {
      colId: "billableMicros",
      headerName: "Billable",
      width: 104,
      aggFunc: "sum",
      enableCellChangeFlash: true,
      valueGetter: (p) => (p.data ? (p.data.status === "accepted" ? p.data.priceMicros : 0) : undefined),
      ...money,
    },
    {
      colId: "taskId",
      field: "taskId",
      headerName: "Task",
      flex: 1.4,
      minWidth: 140,
      enableRowGroup: true,
      valueFormatter: label("taskId"),
      tooltip: (p) => (p.value ? store.taskLabel(p.value) : undefined),
      ...setFilter("taskId"),
    },
    {
      colId: "agentId",
      field: "agentId",
      headerName: "Agent",
      width: 128,
      hide: true,
      enableRowGroup: true,
      cellClass: "tx-mono",
      valueFormatter: label("agentId"),
      tooltip: (p) => p.value ?? undefined,
      ...setFilter("agentId"),
    },
    {
      colId: "review",
      field: "review",
      headerName: "AI review",
      width: 116,
      cellRenderer: ReviewCell,
      enableRowGroup: true,
      enableCellChangeFlash: true,
      valueFormatter: label("review"),
      ...setFilter("review"),
    },
    {
      colId: "latencyMs",
      field: "latencyMs",
      headerName: "Latency",
      width: 100,
      hide: true,
      type: "rightAligned",
      cellClass: "tx-mono",
      enableValue: true,
      aggFunc: "avg",
      allowedAggFuncs: ["avg", "min", "max"],
      valueFormatter: (p) => {
        const n = numericValue(p.value);
        return n == null ? "" : `${formatCount(Math.round(n))} ms`;
      },
      filter: "agNumberColumnFilter",
    },
    {
      colId: "httpStatus",
      field: "httpStatus",
      headerName: "HTTP",
      width: 86,
      hide: true,
      cellClass: "tx-mono",
      cellClassRules: { "tx-http-error": (p) => typeof p.value === "number" && p.value >= 400 },
      filter: "agNumberColumnFilter",
    },
    {
      colId: "tabId",
      field: "tabId",
      headerName: "Tab",
      width: 130,
      hide: true,
      enableRowGroup: true,
      cellClass: "tx-mono",
      valueFormatter: label("tabId"),
      tooltip: (p) => p.value ?? undefined,
      ...setFilter("tabId"),
    },
    { colId: "seq", field: "seq", headerName: "Seq", width: 84, hide: true, type: "rightAligned", cellClass: "tx-mono", filter: "agNumberColumnFilter" },
    {
      colId: "cumulativeMicros",
      field: "cumulativeMicros",
      headerName: "Channel total",
      width: 128,
      hide: true,
      ...money,
      enableValue: false,
    },
    {
      colId: "responseBytes",
      field: "responseBytes",
      headerName: "Bytes",
      width: 96,
      hide: true,
      type: "rightAligned",
      cellClass: "tx-mono",
      valueFormatter: (p) => (typeof p.value === "number" ? formatCount(p.value) : ""),
      filter: "agNumberColumnFilter",
    },
    {
      colId: "settlementId",
      field: "settlementId",
      headerName: "Settlement",
      width: 130,
      hide: true,
      cellClass: "tx-mono",
      valueFormatter: (p) => (p.value ? shortId(p.value) : "Open tab"),
      tooltip: (p) => p.value ?? "Not charged yet: the tab is still open",
      filter: "agSetColumnFilter",
      filterParams: { valueFormatter: (p: ValueFormatterParams) => (p.value ? shortId(String(p.value)) : "Open tab") },
    },
    {
      colId: "id",
      field: "id",
      headerName: "IOU",
      width: 132,
      hide: true,
      cellClass: "tx-mono",
      valueFormatter: label("id"),
      tooltip: (p) => p.value ?? undefined,
      filter: "agTextColumnFilter",
    },
  ];
}

/** Group rows: status and review keys render as pills, the rest as labels. */
function makeGroupInner(store: TerminalStore) {
  return function GroupInner(props: CustomCellRendererProps<VoucherRow>) {
    if (props.node.footer) return <span className="tx-group-total">Total</span>;
    const colId = props.node.rowGroupColumn?.getColId();
    const key = props.node.key;
    if (colId === "status" && key) return key === "accepted" ? <Badge tone="success">Accepted</Badge> : <Badge tone="danger" dot>Voided</Badge>;
    if (colId === "review" && key && ROW_REVIEW[key as RowReview]) {
      const { label, tone } = ROW_REVIEW[key as RowReview];
      return <Badge tone={tone}>{label}</Badge>;
    }
    return <span className="tx-group-key">{bucketText(store, colId, key)}</span>;
  };
}

type GroupPreset = (typeof GROUP_PRESETS)[number]["id"];

/** Toolbar segmented control: Flat / Seller / Agent / Task. Mirrors grouping done any other way. */
function GroupPresets(props: IToolbarItemParams<VoucherRow>) {
  const api = props.api;
  const read = useCallback((): GroupPreset | "custom" => {
    const ids = api.getRowGroupColumns().map((c) => c.getColId());
    if (ids.length === 0) return "";
    return ids.length === 1 && GROUP_PRESETS.some((p) => p.id === ids[0]) ? (ids[0] as GroupPreset) : "custom";
  }, [api]);
  const [current, setCurrent] = useState(read);
  useEffect(() => {
    const onChange = () => setCurrent(read());
    api.addEventListener("columnRowGroupChanged", onChange);
    return () => {
      if (!api.isDestroyed()) api.removeEventListener("columnRowGroupChanged", onChange);
    };
  }, [api, read]);
  return (
    <Segmented<GroupPreset | "custom">
      label="Group IOUs by"
      hideLabel
      className="tx-group-presets"
      value={current}
      onChange={(id) => api.setRowGroupColumns(id && id !== "custom" ? [id] : [])}
      options={GROUP_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
    />
  );
}

function OlderButton(props: IToolbarItemParams<VoucherRow, unknown, { feed: LedgerFeed }>) {
  const feed = props.toolbarItemParams?.feed;
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [title, setTitle] = useState("Load the next 1,000 older IOUs");
  if (!feed) return null;
  return (
    <button
      type="button"
      className="tx-tool-btn"
      disabled={state === "busy"}
      title={title}
      onClick={() => {
        setState("busy");
        feed
          .loadOlder()
          .then((added) => {
            setTitle(added ? `Loaded ${formatCount(added)} older IOUs` : "No older IOUs");
            setState(added ? "idle" : "done");
          })
          .catch(() => {
            setTitle("Couldn't load older IOUs");
            setState("idle");
          });
      }}
    >
      {state === "busy" ? "Loading…" : state === "done" ? "All loaded" : "Load older"}
    </button>
  );
}

const rowClassRules: RowClassRules<VoucherRow> = {
  "tx-row-voided": (p) => !p.node.group && p.data?.status === "voided",
  "tx-row-reviewing": (p) => !p.node.group && p.data?.review === "reviewing",
};

const sideBar: SideBarDef = {
  toolPanels: [
    { id: "columns", labelDefault: "Columns", labelKey: "columns", iconKey: "columns", toolPanel: "agColumnsToolPanel" },
    { id: "filters", labelDefault: "Filters", labelKey: "filters", iconKey: "filter", toolPanel: "agFiltersToolPanel" },
  ],
  position: "right",
  hiddenByDefault: true,
};

const statusBar: { statusPanels: StatusPanelDef[] } = {
  statusPanels: [{ statusPanel: "agTotalAndFilteredRowCountComponent", align: "left" }],
};

const getRowId = (p: GetRowIdParams<VoucherRow>) => p.data.id;
const isRowMaster = (data: VoucherRow | undefined) => Boolean(data?.reviewId);

export interface VouchersGridProps {
  feed: LedgerFeed;
  onApi: (api: GridApi<VoucherRow> | null) => void;
}

export function VouchersGrid({ feed, onApi }: VouchersGridProps) {
  const store = feed.store;
  const theme = useGridTheme();
  const loading = useTerminal((s) => s.phase === "loading");

  const columnDefs = useMemo(() => buildColumns(store), [store]);
  const autoGroupColumnDef = useMemo<ColDef<VoucherRow>>(
    () => ({
      headerName: "Group",
      minWidth: 230,
      cellRendererParams: { innerRenderer: makeGroupInner(store), suppressCount: false },
      tooltip: (p) =>
        p.node?.group && !p.node.footer ? `${bucketText(store, p.node.rowGroupColumn?.getColId(), p.node.key)} (${p.node.allChildrenCount ?? 0})` : undefined,
    }),
    [store],
  );
  const defaultColDef = useMemo<ColDef<VoucherRow>>(() => ({ sortable: true, resizable: true, filter: true, minWidth: 72, suppressHeaderFilterButton: true }), []);

  const toolbar = useMemo<Toolbar>(
    () => ({
      items: [
        { toolbarItem: "agQuickFilterToolbarItem" },
        "separator",
        { toolbarItem: "agRowGroupPanelToolbarItem" },
        { toolbarItem: GroupPresets, key: "groupPresets", alignment: "right" },
        { toolbarItem: "separator", alignment: "right" },
        { toolbarItem: OlderButton, key: "older", alignment: "right", toolbarItemParams: { feed } },
        {
          label: "Columns",
          icon: "columns",
          tooltip: "Show columns and filters",
          alignment: "right",
          action: ({ api }) => {
            const open = api.isSideBarVisible() && api.getOpenedToolPanel() != null;
            if (open) {
              api.closeToolPanel();
              api.setSideBarVisible(false);
            } else {
              api.setSideBarVisible(true);
              api.openToolPanel("columns");
            }
          },
        },
        {
          toolbarItem: "agMenuToolbarItem",
          label: "Export",
          icon: "save",
          tooltip: "Download what's in view as CSV or Excel",
          alignment: "right",
          toolbarItemParams: { menuItems: ["csvExport", "excelExport"] },
        },
      ],
    }),
    [feed],
  );

  const exportParams = useMemo(() => {
    const processCellCallback = (p: ProcessCellForExportParams<VoucherRow>): string => {
      const colId = p.column.getColId();
      const value = p.value;
      if (p.node?.footer && colId === "createdAt") return "Total";
      switch (colId) {
        case "createdAt":
          return typeof value === "number" ? localIso(value) : "";
        case "priceMicros":
        case "billableMicros":
        case "cumulativeMicros": {
          const n = numericValue(value);
          return n == null ? "" : microsToDollarsText(n);
        }
        case "latencyMs": {
          const n = numericValue(value);
          return n == null ? "" : String(Math.round(n));
        }
        case "path":
          return p.node?.data ? `${p.node.data.method} ${p.node.data.path}` : "";
        case "sellerId":
        case "taskId":
        case "status":
        case "review":
          return cellText(store, colId, value);
        case "voidReason":
          return value ? voidReasonLabel(String(value)) : "";
        default:
          return value == null ? "" : String(value);
      }
    };
    const processRowGroupCallback = (p: ProcessRowGroupForExportParams<VoucherRow>): string => {
      if (p.node.footer) return "Total";
      return bucketText(store, p.node.rowGroupColumn?.getColId(), p.node.key);
    };
    return {
      csv: { fileName: `p402-ious-${fileStamp()}.csv`, processCellCallback, processRowGroupCallback },
      excel: { fileName: `p402-ious-${fileStamp()}.xlsx`, sheetName: "IOUs", processCellCallback, processRowGroupCallback },
    };
  }, [store]);

  const onGridReady = useCallback(
    (event: GridReadyEvent<VoucherRow>) => {
      feed.attachGrid(event.api);
      onApi(event.api);
    },
    [feed, onApi],
  );

  useEffect(() => () => onApi(null), [onApi]);

  return (
    <div className="tx-grid">
      <AgGridReact<VoucherRow>
        theme={theme}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        autoGroupColumnDef={autoGroupColumnDef}
        getRowId={getRowId}
        loading={loading}
        onGridReady={onGridReady}
        onGridPreDestroyed={(e) => feed.detachGrid(e.api)}
        asyncTransactionWaitMillis={80}
        deltaSort
        cellFlashDuration={900}
        cellFadeDuration={900}
        rowClassRules={rowClassRules}
        masterDetail
        isRowMaster={isRowMaster}
        detailCellRenderer={ReviewDetail}
        detailRowAutoHeight
        groupDisplayType="singleColumn"
        groupDefaultExpanded={0}
        suppressAggFuncInHeader
        grandTotalRow="pinnedBottom"
        rowGroupPanelSuppressSort
        suppressMenuHide={false}
        toolbar={toolbar}
        sideBar={sideBar}
        statusBar={statusBar}
        cellSelection
        tooltipShowDelay={350}
        overlayComponentParams={{
          noRows: { overlayText: "No IOUs yet. Run an agent from the Console and every paid call clears here." },
          noMatchingRows: { overlayText: "No IOUs match this view." },
        }}
        defaultCsvExportParams={exportParams.csv}
        defaultExcelExportParams={exportParams.excel}
        excelStyles={EXCEL_STYLES}
      />
    </div>
  );
}
