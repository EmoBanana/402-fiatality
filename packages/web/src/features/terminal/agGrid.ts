/**
 * AG Grid Enterprise setup for the clearing terminal. Importing this module (only the terminal chunk does)
 * registers exactly the modules the terminal uses, applies the license key from VITE_AG_GRID_LICENSE_KEY (the
 * grid runs watermarked without one) and exposes a theme built from the design tokens.
 *
 * Every color param is a CSS variable from tokens.css, so the grids follow light/dark and data-theme pins by
 * themselves; `useGridTheme()` only swaps AG Grid's own color-scheme part so its derived shades match.
 * Canvas sparklines can't read CSS variables, so `useTokenColors()` resolves the few they need.
 */
import { AgChartsCommunityModule } from "ag-charts-community";
import {
  CellStyleModule,
  ClientSideRowModelApiModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  DateFilterModule,
  enableDevValidations,
  EventApiModule,
  GridStateModule,
  HighlightChangesModule,
  ModuleRegistry,
  NumberFilterModule,
  PinnedRowModule,
  QuickFilterModule,
  RenderApiModule,
  RowApiModule,
  RowAutoHeightModule,
  RowStyleModule,
  ScrollApiModule,
  TextFilterModule,
  TooltipModule,
  colorSchemeDark,
  colorSchemeLight,
  themeQuartz,
  type Theme,
} from "ag-grid-community";
import {
  AiToolkitModule,
  CellSelectionModule,
  ClipboardModule,
  ColumnMenuModule,
  ColumnsToolPanelModule,
  ContextMenuModule,
  ExcelExportModule,
  FiltersToolPanelModule,
  GroupFilterModule,
  LicenseManager,
  MasterDetailModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  SideBarModule,
  SparklinesModule,
  StatusBarModule,
  ToolbarModule,
} from "ag-grid-enterprise";
import { useMemo, useSyncExternalStore } from "react";
import { type ResolvedTheme, useTheme } from "../../lib/theme";

ModuleRegistry.registerModules([
  // Row model, transactions and APIs
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  RowApiModule,
  ScrollApiModule,
  RenderApiModule,
  ColumnApiModule,
  EventApiModule,
  GridStateModule,
  // Look and feel
  CellStyleModule,
  RowStyleModule,
  HighlightChangesModule,
  TooltipModule,
  ColumnAutoSizeModule,
  PinnedRowModule,
  RowAutoHeightModule,
  // Filtering
  TextFilterModule,
  NumberFilterModule,
  DateFilterModule,
  QuickFilterModule,
  SetFilterModule,
  GroupFilterModule,
  // Enterprise features on show
  RowGroupingModule,
  RowGroupingPanelModule,
  MasterDetailModule,
  SparklinesModule.with(AgChartsCommunityModule),
  StatusBarModule,
  SideBarModule,
  ColumnsToolPanelModule,
  FiltersToolPanelModule,
  ColumnMenuModule,
  ContextMenuModule,
  CellSelectionModule,
  ClipboardModule,
  ToolbarModule,
  CsvExportModule,
  ExcelExportModule,
  AiToolkitModule,
]);

if (import.meta.env.DEV) enableDevValidations();

const licenseKey = import.meta.env.VITE_AG_GRID_LICENSE_KEY?.trim();
if (licenseKey) LicenseManager.setLicenseKey(licenseKey);

function buildGridTheme(mode: ResolvedTheme): Theme {
  return themeQuartz.withPart(mode === "dark" ? colorSchemeDark : colorSchemeLight).withParams({
    browserColorScheme: mode,
    accentColor: "var(--accent)",
    backgroundColor: "var(--surface)",
    foregroundColor: "var(--ink)",
    textColor: "var(--ink-2)",
    subtleTextColor: "var(--muted)",
    borderColor: "var(--hairline)",
    chromeBackgroundColor: "var(--surface)",
    headerBackgroundColor: "var(--surface)",
    headerTextColor: "var(--muted)",
    headerFontWeight: 500,
    headerFontSize: 12,
    headerHeight: 38,
    rowHeight: 38,
    fontFamily: "var(--font-sans)",
    fontSize: 13,
    spacing: 6,
    cellHorizontalPadding: 12,
    iconColor: "var(--muted)",
    borderRadius: 8,
    wrapperBorder: false,
    wrapperBorderRadius: 0,
    columnBorder: false,
    headerColumnBorder: false,
    rowBorder: { color: "var(--hairline)" },
    headerRowBorder: { color: "var(--hairline)" },
    rowHoverColor: "color-mix(in srgb, var(--accent) 5%, transparent)",
    selectedRowBackgroundColor: "var(--accent-soft)",
    oddRowBackgroundColor: "var(--surface)",
    rangeSelectionBorderColor: "var(--accent)",
    rangeSelectionBackgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)",
    valueChangeValueHighlightBackgroundColor: "color-mix(in srgb, var(--accent) 22%, transparent)",
    pinnedRowBackgroundColor: "var(--surface-2)",
    pinnedRowFontWeight: 600,
    pinnedRowBorder: { color: "var(--hairline-strong)" },
    menuBackgroundColor: "var(--surface)",
    menuBorder: { color: "var(--hairline)" },
    menuTextColor: "var(--ink)",
    panelBackgroundColor: "var(--surface)",
    popupShadow: "var(--shadow-overlay)",
    tooltipBackgroundColor: "var(--ink)",
    tooltipTextColor: "var(--surface)",
    tooltipBorder: false,
    toolbarBackgroundColor: "var(--surface)",
    toolbarTextColor: "var(--ink-2)",
    sideBarBackgroundColor: "var(--surface)",
    sideButtonBarBackgroundColor: "var(--surface)",
    sideButtonSelectedBackgroundColor: "var(--surface-2)",
    statusBarLabelColor: "var(--muted)",
    statusBarValueColor: "var(--ink)",
    columnDropCellBackgroundColor: "var(--accent-soft)",
    columnDropCellTextColor: "var(--accent)",
    columnDropCellBorder: { color: "transparent" },
    findMatchBackgroundColor: "color-mix(in srgb, var(--warning) 25%, transparent)",
    findActiveMatchBackgroundColor: "color-mix(in srgb, var(--warning) 45%, transparent)",
  });
}

/** The grid theme for the current light/dark mode. */
export function useGridTheme(): Theme {
  const { resolved } = useTheme();
  return useMemo(() => buildGridTheme(resolved), [resolved]);
}

export interface TokenColors {
  accent: string;
  accentSoft: string;
  danger: string;
  muted: string;
  hairline: string;
  surface: string;
}

const FALLBACK: TokenColors = {
  accent: "#1d3a6e",
  accentSoft: "#eef2f9",
  danger: "#b42318",
  muted: "#71717a",
  hairline: "#e7e5e4",
  surface: "#ffffff",
};

function readTokens(): TokenColors {
  if (typeof document === "undefined") return FALLBACK;
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    accent: read("--accent", FALLBACK.accent),
    accentSoft: read("--accent-soft", FALLBACK.accentSoft),
    danger: read("--danger", FALLBACK.danger),
    muted: read("--muted", FALLBACK.muted),
    hairline: read("--hairline", FALLBACK.hairline),
    surface: read("--surface", FALLBACK.surface),
  };
}

let tokenCache: { key: string; colors: TokenColors } | null = null;

/** Concrete token colors for canvas renderers (AG Charts sparklines), re-read when the theme flips. */
export function useTokenColors(): TokenColors {
  const { resolved, preference } = useTheme();
  const key = `${resolved}:${preference}`;
  // useSyncExternalStore keeps the read in render without a flash of stale colors.
  return useSyncExternalStore(
    noopSubscribe,
    () => {
      if (!tokenCache || tokenCache.key !== key) tokenCache = { key, colors: readTokens() };
      return tokenCache.colors;
    },
    () => FALLBACK,
  );
}

const noopSubscribe = () => () => {};
