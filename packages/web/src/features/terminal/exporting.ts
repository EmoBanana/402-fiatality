/**
 * CSV / Excel export settings shared by the terminal grids. Money columns carry the `tx-money` cell class:
 * exports write them as plain dollar numbers with a currency format that keeps sub-cent digits ($0.005),
 * and times as real Excel date-times.
 */
import type { ExcelStyle } from "ag-grid-community";

export const EXCEL_STYLES: ExcelStyle[] = [
  { id: "tx-money", dataType: "Number", numberFormat: { format: "$#,##0.00####" } },
  { id: "tx-time", dataType: "DateTime", numberFormat: { format: "yyyy-mm-dd hh:mm:ss" } },
  { id: "tx-pct", dataType: "Number", numberFormat: { format: "0.00%" } },
  { id: "header", font: { bold: true } },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DDTHH:mm:ss" (what Excel's DateTime cells expect). */
export function localIso(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function fileStamp(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export function microsToDollarsText(micros: number): string {
  return String(micros / 1_000_000);
}

export function centsToDollarsText(cents: number): string {
  return String(cents / 100);
}
