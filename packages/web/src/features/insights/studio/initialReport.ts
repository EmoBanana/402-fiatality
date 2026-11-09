/**
 * The report AG Studio opens with: a "Calls" page (KPIs, billed by tab and seller, void rate by seller,
 * latest calls) and a "Fees" page (per-call fees versus the one batched charge, settled tabs). Analysts
 * can edit it, and Gemma can add to it from the AI panel. Canvas: 24 columns, 16 px rows.
 */
import type { AgReportState } from "ag-studio";

const title = (text: string) => ({ title: { text, enabled: true } });
/** A title plus a legend under the plot: for charts whose color carries a dimension (sellers, fee kinds). */
const titleWithLegend = (text: string) => ({
  ...title(text),
  style: { theme: { common: { legend: { enabled: true, position: "bottom" as const } } } },
});

export const INITIAL_REPORT: AgReportState = {
  selectedPageId: "calls",
  // Open on the canvas and the AI assistant; data, compose and filter panels start collapsed.
  panels: { data: { collapsed: true }, edit: { collapsed: true }, filters: { collapsed: true } },
  pages: [
    {
      id: "calls",
      widgets: {
        "kpi-calls": { type: "value", format: title("Paid calls"), dataMapping: { value: [{ id: "vouchers.id", aggregation: "count" }] } },
        "kpi-billed": { type: "value", format: title("Billed"), dataMapping: { value: [{ id: "vouchers.billedUsd", aggregation: "sum" }] } },
        "kpi-void-rate": { type: "value", format: title("Void rate"), dataMapping: { value: [{ id: "vouchers.voided", aggregation: "avg" }] } },
        "kpi-latency": { type: "value", format: title("Avg latency (ms)"), dataMapping: { value: [{ id: "vouchers.latencyMs", aggregation: "avg" }] } },
        "billed-by-tab": {
          type: "column-chart-stacked",
          format: titleWithLegend("Billed by tab and seller"),
          dataMapping: {
            categoryKey: [{ id: "vouchers.tab" }],
            valueKey: [{ id: "vouchers.billedUsd", aggregation: "sum" }],
            legendKey: [{ id: "vouchers.seller" }],
          },
          // Sellers in a fixed order, so each keeps the color it has in the charts above.
          sort: [{ field: { id: "vouchers.seller" }, direction: "asc" }],
        },
        "void-rate-by-seller": {
          type: "bar-chart-grouped",
          format: title("Void rate by seller"),
          dataMapping: {
            categoryKey: [{ id: "vouchers.seller" }],
            valueKey: [{ id: "vouchers.voided", aggregation: "avg" }],
          },
        },
        "latest-calls": {
          type: "grid",
          format: title("Latest calls"),
          dataMapping: {
            cols: [
              { id: "vouchers.createdAt" },
              { id: "vouchers.seller" },
              { id: "vouchers.endpoint" },
              { id: "vouchers.status" },
              { id: "vouchers.voidReason" },
              { id: "vouchers.priceUsd" },
              { id: "vouchers.latencyMs" },
            ],
          },
        },
      },
      widgetLayout: {
        "kpi-calls": { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 6 },
        "kpi-billed": { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 6 },
        "kpi-void-rate": { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 6 },
        "kpi-latency": { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 6 },
        "billed-by-tab": { xTrack: 0, yTrack: 6, xSpan: 14, ySpan: 18 },
        "void-rate-by-seller": { xTrack: 14, yTrack: 6, xSpan: 10, ySpan: 18 },
        "latest-calls": { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 20 },
      },
    },
    {
      id: "fees",
      widgets: {
        "kpi-charged": { type: "value", format: title("Charged on PayPal"), dataMapping: { value: [{ id: "settlements.chargedUsd", aggregation: "sum" }] } },
        "kpi-fees": { type: "value", format: title("PayPal fees"), dataMapping: { value: [{ id: "settlements.paypalFeeUsd", aggregation: "sum" }] } },
        "kpi-saved": { type: "value", format: title("Saved by batching"), dataMapping: { value: [{ id: "settlements.savedUsd", aggregation: "sum" }] } },
        "fees-by-tab": {
          type: "column-chart-grouped",
          format: titleWithLegend("Per-call fees vs one batched charge"),
          dataMapping: {
            categoryKey: [{ id: "settlements.tab" }],
            valueKey: [
              { id: "settlements.perCallFeeUsd", aggregation: "sum" },
              { id: "settlements.paypalFeeUsd", aggregation: "sum" },
            ],
          },
        },
        "settled-tabs": {
          type: "grid",
          format: title("Settled tabs"),
          dataMapping: {
            cols: [
              { id: "settlements.tab" },
              { id: "settlements.settledAt" },
              { id: "settlements.chargedUsd" },
              { id: "settlements.paypalFeeUsd" },
              { id: "settlements.feeRate" },
              { id: "settlements.perCallFeeUsd" },
              { id: "settlements.calls" },
            ],
          },
        },
      },
      widgetLayout: {
        "kpi-charged": { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 6 },
        "kpi-fees": { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 6 },
        "kpi-saved": { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 6 },
        "fees-by-tab": { xTrack: 0, yTrack: 6, xSpan: 24, ySpan: 18 },
        "settled-tabs": { xTrack: 0, yTrack: 24, xSpan: 24, ySpan: 16 },
      },
    },
  ],
};

export const PROMPT_STARTERS = [
  { label: "Which seller voids most?", prompt: "Which seller has the highest void rate, and what are the main void reasons?" },
  { label: "Spend by seller", prompt: "Add a chart of billed spend by seller to this page." },
  { label: "Slowest endpoints", prompt: "Which endpoints have the highest average latency? Add a bar chart." },
  { label: "Fees saved", prompt: "How much did batching save in PayPal fees compared with per-call payments?" },
];
