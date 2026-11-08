/**
 * "Ask the ledger": natural-language questions answered by the AG Grid AI Toolkit.
 *   gridApi.getStructuredSchema() + gridApi.getState()  ->  POST /api/ai/grid-query  ->  gridApi.setState()
 * Only the sections the model is allowed to drive (filter, sort, rowGroup, aggregation, columnVisibility) are
 * sent and applied; every other section (scroll, sizing, side bar, expansion...) is passed in
 * `propertiesToIgnore` so it survives. A section the model leaves out or returns as null stays unchanged;
 * an explicit empty one clears it. Column ids are validated before anything reaches the grid.
 */
import type {
  AggregationState,
  ColumnVisibilityState,
  FilterState,
  GridApi,
  GridState,
  GridStateKey,
  RowGroupState,
  SortState,
  StructuredSchemaParams,
} from "ag-grid-community";
import { type FormEvent, useId, useRef, useState } from "react";
import { Badge, Button, Input } from "../../components";
import { ApiError, api as gateway } from "../../lib/api";
import { modelLabel } from "../../lib/format";
import type { VoucherRow } from "./store";

const ALL_STATE_KEYS = {
  aggregation: true,
  cellSelection: true,
  columnGroup: true,
  columnHeaderName: true,
  columnOrder: true,
  columnPinning: true,
  columnSizing: true,
  columnVisibility: true,
  filter: true,
  find: true,
  focusedCell: true,
  pagination: true,
  pivot: true,
  quickFilter: true,
  rowGroup: true,
  rowGroupExpansion: true,
  rowPinning: true,
  rowSelection: true,
  scroll: true,
  showValuesAs: true,
  sideBar: true,
  sort: true,
  ssrmRowGroupExpansion: true,
  userColumns: true,
} as const satisfies Record<GridStateKey, true>;

/** The sections "Ask the ledger" may change. */
const AI_KEYS = ["filter", "sort", "rowGroup", "aggregation", "columnVisibility"] as const satisfies readonly GridStateKey[];
type AiKey = (typeof AI_KEYS)[number];

/** Column hints for the model: units, meanings, and set values for low-cardinality columns. */
const SCHEMA_PARAMS: StructuredSchemaParams = {
  exclude: ["pivot", "columnSizing"],
  columns: {
    createdAt: {
      description:
        "When the IOU cleared (local time). For relative ranges use the custom filter types last15Minutes, lastHour or last24Hours (no dateFrom needed).",
    },
    sellerId: { description: "Seller (API provider) id.", includeSetValues: true },
    path: { description: "Request path on the seller's API, e.g. /v1/search or /v1/reviews/:id." },
    status: { description: "accepted = billable; voided = a bad response, never billed (see voidReason).", includeSetValues: true },
    voidReason: { description: "Why an IOU was voided; blank when accepted.", includeSetValues: true },
    priceMicros: { description: "Signed price of the call in micro-dollars (1 USD = 1,000,000; 5000 = half a cent)." },
    billableMicros: { description: "What the call adds to the bill in micro-dollars: the price when accepted, 0 when voided." },
    taskId: { description: "Agent run (task) that paid for the call. Group by it to see spend per task.", includeSetValues: true },
    agentId: { description: "Agent that signed the IOU.", includeSetValues: true },
    review: {
      description:
        "What the AI spend review that examined the call decided for it: reviewing (still debating), voided (voided by the review), reviewed (already void, read as evidence), kept, frozen (agent frozen for needless spend) or escalated; blank if never reviewed.",
      includeSetValues: true,
    },
    latencyMs: { description: "Seller response time in milliseconds." },
    httpStatus: { description: "HTTP status code the seller returned." },
    tabId: { description: "Company tab (one PayPal hold) the call is billed to.", includeSetValues: true },
    seq: { description: "Sequence number of the IOU on its tab/seller payment channel." },
    cumulativeMicros: { description: "Running total signed on the tab/seller channel, in micro-dollars." },
    responseBytes: { description: "Size of the seller's response in bytes." },
    settlementId: { description: "Settlement (the one PayPal capture) that charged this IOU; blank while the tab is open." },
    id: { description: "IOU (voucher) id." },
  },
};

const EXAMPLE_QUESTIONS = [
  "Show only voided calls",
  "Group by seller",
  "Most expensive calls first",
  "Calls from the last hour",
  "Group by task",
] as const;

function pickState(state: GridState, keys: readonly AiKey[]): GridState {
  const out: GridState = {};
  for (const key of keys) if (state[key] !== undefined) (out as Record<string, unknown>)[key] = state[key];
  return out;
}

function ignoreAllBut(keys: readonly GridStateKey[]): GridStateKey[] {
  return (Object.keys(ALL_STATE_KEYS) as GridStateKey[]).filter((key) => !keys.includes(key));
}

/** Keep only well-formed sections that name real columns. */
function sanitize(grid: GridApi<VoucherRow>, raw: Record<string, unknown>, ignore: readonly string[]): { next: GridState; applied: AiKey[] } {
  const next: GridState = {};
  const applied: AiKey[] = [];
  const isCol = (id: unknown): id is string => typeof id === "string" && grid.getColumn(id) != null;
  const wants = (key: AiKey) => raw[key] != null && typeof raw[key] === "object" && !ignore.includes(key);

  if (wants("filter")) {
    const model = (raw.filter as FilterState).filterModel ?? {};
    next.filter = {
      filterModel: Object.fromEntries(Object.entries(model).filter(([colId, value]) => isCol(colId) && value != null && typeof value === "object")),
    };
    applied.push("filter");
  }
  if (wants("sort")) {
    const items = (raw.sort as SortState).sortModel ?? [];
    next.sort = {
      sortModel: items
        .filter((item) => isCol(item?.colId) && (item.sort === "asc" || item.sort === "desc"))
        .map((item) => ({ colId: item.colId, sort: item.sort, ...(item.type === "absolute" ? { type: item.type } : {}) })),
    };
    applied.push("sort");
  }
  if (wants("rowGroup")) {
    const ids = (raw.rowGroup as RowGroupState).groupColIds ?? [];
    next.rowGroup = { groupColIds: ids.filter((id) => isCol(id) && grid.getColumn(id)?.isAllowRowGroup()) };
    applied.push("rowGroup");
  }
  if (wants("aggregation")) {
    const items = (raw.aggregation as AggregationState).aggregationModel ?? [];
    next.aggregation = { aggregationModel: items.filter((item) => isCol(item?.colId) && typeof item.aggFunc === "string") };
    applied.push("aggregation");
  }
  if (wants("columnVisibility")) {
    const hidden = (raw.columnVisibility as ColumnVisibilityState).hiddenColIds ?? [];
    next.columnVisibility = { hiddenColIds: hidden.filter(isCol) };
    applied.push("columnVisibility");
  }
  return { next, applied };
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Can't reach the gateway. Start it with `npm run dev`.";
    if (err.status === 503) return "The ledger's AI service isn't wired up yet.";
    return err.message || "The model couldn't answer that.";
  }
  return err instanceof Error ? err.message : "The model couldn't answer that.";
}

interface Answer {
  question: string;
  explanation: string;
  model: string;
  applied: AiKey[];
}

export interface AskLedgerProps {
  grid: GridApi<VoucherRow> | null;
  /** Called before a question runs (e.g. to bring the IOU grid into view). */
  onAsk?: () => void;
}

export function AskLedger({ grid, onAsk }: AskLedgerProps) {
  const inputId = useId();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const baseline = useRef<GridState | null>(null);
  const inflight = useRef<AbortController | null>(null);

  async function ask(text: string) {
    const q = text.trim();
    if (!grid || grid.isDestroyed() || !q) return;
    onAsk?.();
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setBusy(true);
    setError(null);
    try {
      const schema = grid.getStructuredSchema(SCHEMA_PARAMS) as Record<string, unknown>;
      const state = pickState(grid.getState(), AI_KEYS) as Record<string, unknown>;
      const res = await gateway.ai.gridQuery({ question: q, schema, state }, controller.signal);
      if (grid.isDestroyed()) return;
      const { next, applied } = sanitize(grid, res.state ?? {}, res.propertiesToIgnore ?? []);
      if (applied.length > 0) {
        baseline.current ??= pickState(grid.getState(), AI_KEYS);
        grid.setState(next, ignoreAllBut(applied));
      }
      setAnswer({
        question: q,
        explanation: res.explanation?.trim() || (applied.length ? "Updated the view." : "Nothing in the view needed to change."),
        model: res.model,
        applied,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(describeError(err));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setBusy(false);
      }
    }
  }

  function reset() {
    if (grid && !grid.isDestroyed() && baseline.current) grid.setState(baseline.current, ignoreAllBut(AI_KEYS));
    baseline.current = null;
    setAnswer(null);
    setError(null);
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  return (
    <section className="tx-ask" aria-label="Ask the ledger">
      <form className="tx-ask-form" onSubmit={onSubmit}>
        <Input
          id={inputId}
          className="tx-ask-field"
          aria-label="Ask the ledger a question"
          placeholder="Ask the ledger, e.g. which seller voided the most in the last hour?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          autoComplete="off"
          prefix={
            <span className="tx-ask-prefix" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5l1.6 4.2 4.4 1.6-4.4 1.6L8 13.1 6.4 8.9 2 7.3l4.4-1.6L8 1.5z" fill="currentColor" />
              </svg>
              Ask the ledger
            </span>
          }
          suffix={
            <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!grid || question.trim() === ""}>
              Ask
            </Button>
          }
        />
      </form>
      <div className="tx-ask-row">
        {answer || error ? (
          <div className="tx-ask-answer" role="status" data-tone={error ? "danger" : undefined}>
            {error ? (
              <p className="tx-ask-text">{error}</p>
            ) : answer ? (
              <>
                <Badge tone="accent">{modelLabel(answer.model)}</Badge>
                <p className="tx-ask-text">
                  <span className="tx-ask-q">“{answer.question}”</span> {answer.explanation}
                </p>
              </>
            ) : null}
            {answer && answer.applied.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={reset}>
                Reset view
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => (setError(null), setAnswer(null))}>
                Dismiss
              </Button>
            )}
          </div>
        ) : (
          <div className="tx-ask-examples">
            <span className="tx-ask-try">Try</span>
            {EXAMPLE_QUESTIONS.map((example) => (
              <button
                key={example}
                type="button"
                className="tx-chip"
                disabled={!grid || busy}
                onClick={() => {
                  setQuestion(example);
                  void ask(example);
                }}
              >
                {example}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
