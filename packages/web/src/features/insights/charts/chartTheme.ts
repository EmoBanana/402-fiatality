/**
 * AG Charts setup for the Insights page. Only community modules are registered: the bundled AG license
 * key does not cover standalone AG Charts Enterprise, and every view here (bars, lines, scatter, shared
 * tooltips, cross lines) is a community feature, so the charts render without a watermark.
 */
import { AllCommunityModule, type AgChartTheme, ModuleRegistry } from "ag-charts-community";
import type { Tokens } from "../tokens";

ModuleRegistry.registerModules([AllCommunityModule]);

/** The page's chart theme: tokens for ink, hairlines and surfaces; --series-* for categorical color. */
export function chartTheme(t: Tokens): AgChartTheme {
  return {
    baseTheme: t.mode === "dark" ? "ag-default-dark" : "ag-default",
    palette: { fills: t.series, strokes: t.series },
    params: {
      fontFamily: t.fontSans,
      fontSize: 12,
      backgroundColor: t.surface,
      chartBackgroundColor: t.surface,
      foregroundColor: t.ink,
      textColor: t.ink2,
      subtleTextColor: t.muted,
      accentColor: t.accent,
      borderColor: t.hairline,
      axisLineColor: t.hairlineStrong,
      axisLabelColor: t.muted,
      gridLineColor: t.hairline,
      legendLabelColor: t.ink2,
      tooltipBackgroundColor: t.surface,
      tooltipTextColor: t.ink,
      chartPadding: 4,
    },
  };
}

/** $0.045, $2.24, $1,204 — keeps sub-cent precision for tiny per-call amounts. */
export function formatDollars(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  const digits = abs === 0 ? 2 : abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  const text = abs.toLocaleString("en-US", { minimumFractionDigits: abs >= 1000 ? 0 : 2, maximumFractionDigits: abs >= 1000 ? 0 : digits });
  return `${value < 0 ? "-" : ""}$${text}`;
}

/** Axis ticks: clean, compact ($0, $0.05, $2, $1.2K). */
export function formatDollarTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 1 })}K`;
  if (abs >= 10 || abs === 0) return `$${Math.round(value).toLocaleString("en-US")}`;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: abs < 0.01 ? 4 : abs < 0.1 ? 3 : 2 })}`;
}
