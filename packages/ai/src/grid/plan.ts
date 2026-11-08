/**
 * A compact "grid plan" (what the model or the rules produce) -> AG Grid state for
 * `gridApi.setState(state, propertiesToIgnore)`. The state is the current one with the changed sections
 * replaced; every section the plan leaves alone goes into propertiesToIgnore, so column order, sizes,
 * selection and scroll stay put.
 */
import { dollarsToMicros, formatUsd } from "@p402/shared";
import { isRecord } from "../llm/schema";
import { listJoin, plural } from "../util/text";
import type { FilterKind, GridColumn, GridSchemaSummary } from "./schema";

export const FILTER_OPS = [
  "in",
  "equals",
  "notEqual",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "inRange",
  "blank",
  "notBlank",
] as const;

export type FilterOp = (typeof FILTER_OPS)[number];

export interface PlanFilter {
  colId: string;
  op: FilterOp;
  value?: string | number | null;
  valueTo?: string | number | null;
  values?: string[];
}

export interface GridPlan {
  filters: PlanFilter[];
  sort: Array<{ colId: string; dir: "asc" | "desc" }>;
  groupBy: string[];
  aggregate: Array<{ colId: string; func: string }>;
  /** Start from a clean view (clear filters, sort, grouping) instead of changing the current one. */
  reset: boolean;
}

/** AG Grid 36 GridStateKey values. */
export const GRID_STATE_KEYS = [
  "aggregation",
  "cellSelection",
  "columnGroup",
  "columnHeaderName",
  "columnOrder",
  "columnPinning",
  "columnSizing",
  "columnVisibility",
  "filter",
  "find",
  "focusedCell",
  "pagination",
  "pivot",
  "quickFilter",
  "rowGroup",
  "rowGroupExpansion",
  "rowPinning",
  "rowSelection",
  "scroll",
  "showValuesAs",
  "sideBar",
  "sort",
  "ssrmRowGroupExpansion",
  "userColumns",
];

const NOT_STATE_KEYS = new Set(["version", "partialColumnState", "rangeSelection"]);

export interface PlannedState {
  state: Record<string, unknown>;
  propertiesToIgnore: string[];
  /** What changed, in words: predicates after "where" ("status is voided") and trailing phrases
   * ("created in the last hour", "grouped by seller"). */
  applied: { where: string[]; tail: string[] };
  /** Plan items that did not fit the grid. */
  skipped: string[];
}

export function planToState(plan: GridPlan, grid: GridSchemaSummary, current: Record<string, unknown>, now: number): PlannedState {
  const byId = new Map(grid.columns.map((c) => [c.id, c]));
  const applied: PlannedState["applied"] = { where: [], tail: [] };
  const skipped: string[] = [];
  const changes: Record<string, unknown> = {};
  const column = (id: string) => byId.get(id) ?? grid.columns.find((c) => c.id.toLowerCase() === id.toLowerCase());

  if (grid.features.filter && (plan.reset || plan.filters.length > 0)) {
    const currentModel = isRecord(current.filter) && isRecord(current.filter.filterModel) ? current.filter.filterModel : {};
    const filterModel: Record<string, unknown> = plan.reset ? {} : { ...currentModel };
    let built = 0;
    for (const f of plan.filters) {
      const c = column(f.colId);
      const filter = c ? buildFilter(f, c, now) : null;
      if (c && filter) {
        filterModel[c.id] = filter.model;
        (filter.tail ? applied.tail : applied.where).push(filter.text);
        built += 1;
      } else {
        skipped.push(`filter on ${f.colId}`);
      }
    }
    if (built > 0 || plan.reset) changes.filter = { filterModel };
  } else if (plan.filters.length > 0) {
    skipped.push("filters (this grid exposes no column filters)");
  }

  // A new view replaces filters and grouping; sorting is only cleared by an explicit "reset".
  const clearAll = plan.reset && !plan.filters.length && !plan.sort.length && !plan.groupBy.length && !plan.aggregate.length;
  if (grid.features.sort && (clearAll || plan.sort.length > 0)) {
    const sortModel: Array<{ colId: string; sort: "asc" | "desc"; type: "default" }> = [];
    for (const s of plan.sort) {
      const c = column(s.colId);
      if (c?.sortable && !sortModel.some((m) => m.colId === c.id)) {
        sortModel.push({ colId: c.id, sort: s.dir, type: "default" });
        applied.tail.push(`sorted by ${label(c)} (${s.dir === "desc" ? "highest first" : "lowest first"})`);
      } else skipped.push(`sort on ${s.colId}`);
    }
    if (sortModel.length > 0 || clearAll) changes.sort = { sortModel };
  }

  if (grid.features.rowGroup && (plan.reset || plan.groupBy.length > 0)) {
    const groupColIds: string[] = [];
    for (const id of plan.groupBy) {
      const c = column(id);
      if (c?.groupable && !groupColIds.includes(c.id)) {
        groupColIds.push(c.id);
        applied.tail.push(`grouped by ${label(c)}`);
      } else skipped.push(`grouping by ${id}`);
    }
    if (groupColIds.length > 0 || plan.reset) changes.rowGroup = { groupColIds };
  }

  if (grid.features.aggregation && plan.aggregate.length > 0) {
    const existing =
      !plan.reset && isRecord(current.aggregation) && Array.isArray(current.aggregation.aggregationModel)
        ? (current.aggregation.aggregationModel as Array<{ colId: string; aggFunc: string }>)
        : [];
    const model = new Map(existing.map((a) => [a.colId, a.aggFunc]));
    let added = 0;
    for (const a of plan.aggregate) {
      const c = column(a.colId);
      const func = c?.aggFuncs.find((f) => f.toLowerCase() === a.func.toLowerCase());
      if (c && func) {
        model.set(c.id, func);
        applied.tail.push(`with the ${func} of ${label(c)}`);
        added += 1;
      } else skipped.push(`${a.func} of ${a.colId}`);
    }
    if (added > 0) changes.aggregation = { aggregationModel: [...model].map(([colId, aggFunc]) => ({ colId, aggFunc })) };
  }

  // A plan whose every item was unusable changes nothing (rather than half-resetting the view).
  if (applied.where.length + applied.tail.length === 0 && skipped.length > 0) {
    for (const key of Object.keys(changes)) delete changes[key];
  }

  const state: Record<string, unknown> = { ...current, ...changes };
  const propertiesToIgnore = [...new Set([...GRID_STATE_KEYS, ...Object.keys(current)])].filter(
    (key) => !(key in changes) && !NOT_STATE_KEYS.has(key),
  );
  return { state, propertiesToIgnore, applied, skipped };
}

/** "Showing calls where status is voided, created in the last hour, grouped by seller." */
export function explainPlan(planned: PlannedState, reset: boolean): string {
  const { where, tail } = planned.applied;
  let text: string;
  if (where.length > 0) text = `Showing calls where ${listJoin(where)}${tail.length ? `, ${tail.join(", ")}` : ""}.`;
  else if (tail.length > 0) text = `Showing calls ${tail.join(", ")}.`;
  else if (reset && planned.skipped.length === 0) text = "Cleared the filters, sorting and grouping.";
  else text = "I couldn't map that question to this grid's columns.";
  if (planned.skipped.length > 0) text += ` Skipped: ${listJoin(planned.skipped.slice(0, 3))}.`;
  return text;
}

/** "sellerId" -> "seller", "priceMicros" -> "price", "createdAt" -> "created at". */
export function label(c: GridColumn): string {
  const words = c.id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return words.replace(/\s(?:id|micros|ms)$/, "") || c.id;
}

// ---------------------------------------------------------------- filters

interface BuiltFilter {
  model: Record<string, unknown>;
  text: string;
  /** Reads as a trailing phrase ("created in the last hour") rather than a "where" predicate. */
  tail?: boolean;
}

const NUMBER_OPS = ["equals", "notEqual", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "inRange", "blank", "notBlank"];
const TEXT_OPS = ["contains", "notContains", "equals", "notEqual", "startsWith", "endsWith", "blank", "notBlank"];
const DATE_OPS = ["equals", "notEqual", "lessThan", "greaterThan", "inRange", "blank", "notBlank"];
const OP_WORDS: Record<string, string> = {
  equals: "is",
  notEqual: "is not",
  contains: "contains",
  notContains: "does not contain",
  startsWith: "starts with",
  endsWith: "ends with",
  greaterThan: "is above",
  greaterThanOrEqual: "is at least",
  lessThan: "is below",
  lessThanOrEqual: "is at most",
  inRange: "is between",
  blank: "is blank",
  notBlank: "is not blank",
};

function buildFilter(f: PlanFilter, c: GridColumn, now: number): BuiltFilter | null {
  if (c.filter === "multi") {
    const kinds = c.multi ?? [];
    const wantsSet = f.op === "in" || (f.values?.length ?? 0) > 1;
    let index = wantsSet ? kinds.indexOf("set") : kinds.findIndex((k) => k !== "set");
    if (index < 0) index = kinds.findIndex((k) => k !== undefined);
    const kind = kinds[index];
    if (!kind) return null;
    const child = buildSimple(f, { ...c, filter: kind }, kind, now);
    if (!child) return null;
    return { ...child, model: { filterType: "multi", filterModels: kinds.map((_, i) => (i === index ? child.model : null)) } };
  }
  return c.filter ? buildSimple(f, c, c.filter, now) : null;
}

function buildSimple(f: PlanFilter, c: GridColumn, kind: FilterKind, now: number): BuiltFilter | null {
  const name = label(c);
  if (kind === "set") {
    const asked = (f.values?.length ? f.values : f.value !== null && f.value !== undefined ? [String(f.value)] : []).map(String);
    const known = c.values;
    const match = (v: string) => known?.find((k) => k.toLowerCase() === v.toLowerCase());
    let values = known ? asked.map(match).filter((v): v is string => !!v) : asked;
    if (f.op === "notEqual" && known) values = known.filter((k) => !values.includes(k));
    else if (f.op !== "in" && f.op !== "equals") return null;
    if (values.length === 0) return null;
    const shown = values.length > 1 ? `${values.slice(0, -1).join(", ")} or ${values.at(-1)}` : values[0];
    return { model: { filterType: "set", values }, text: `${name} is ${shown}` };
  }

  const op: FilterOp = f.op === "in" ? "equals" : f.op;
  const noValue = op === "blank" || op === "notBlank";

  if (kind === "text") {
    const ops = c.ops ?? TEXT_OPS;
    const value = f.values?.[0] ?? f.value;
    if (!ops.includes(op) || (!noValue && (value === null || value === undefined || value === ""))) return null;
    return {
      model: { filterType: "text", type: op, ...(noValue ? {} : { filter: String(value) }) },
      text: `${name} ${OP_WORDS[op] ?? op}${noValue ? "" : ` “${value}”`}`,
    };
  }

  if (kind === "number" || kind === "bigint") {
    const ops = c.ops ?? NUMBER_OPS;
    const resolved = ops.includes(op) ? op : relax(op, ops);
    if (!resolved) return null;
    const from = noValue ? null : toNumber(f.values?.[0] ?? f.value, c, now);
    const to = resolved === "inRange" ? toNumber(f.valueTo, c, now) : null;
    if (!noValue && from === null) return null;
    if (resolved === "inRange" && to === null) return null;
    const value = (n: number) => (kind === "bigint" ? String(Math.round(n)) : n);
    return {
      model: {
        filterType: kind,
        type: resolved,
        ...(from === null ? {} : { filter: value(from) }),
        ...(to === null ? {} : { filterTo: value(to) }),
      },
      ...(isTimeColumn(c)
        ? { text: timeText(name, resolved, from, to, now), tail: true }
        : { text: [name, OP_WORDS[resolved] ?? resolved, from === null ? "" : showNumber(from, c), to === null ? "" : `and ${showNumber(to, c)}`].filter(Boolean).join(" ") }),
    };
  }

  if (kind === "date") {
    const ops = c.ops ?? DATE_OPS;
    const resolved = ops.includes(op) ? op : relax(op, ops);
    if (!resolved) return null;
    const from = noValue ? null : toTime(f.values?.[0] ?? f.value, now);
    const to = resolved === "inRange" ? toTime(f.valueTo, now) : null;
    if ((!noValue && from === null) || (resolved === "inRange" && to === null)) return null;
    return {
      model: { filterType: "date", type: resolved, dateFrom: from === null ? null : agDate(from), dateTo: to === null ? null : agDate(to) },
      text: timeText(name, resolved, from, to, now),
      tail: true,
    };
  }
  return null;
}

/** greaterThanOrEqual -> greaterThan (and the like) when the filter lacks the inclusive variant. */
function relax(op: FilterOp, ops: string[]): FilterOp | null {
  const fallback: Partial<Record<FilterOp, FilterOp>> = { greaterThanOrEqual: "greaterThan", lessThanOrEqual: "lessThan", in: "equals" };
  const alt = fallback[op];
  return alt && ops.includes(alt) ? alt : null;
}

function isMoneyMicros(c: GridColumn): boolean {
  return /micros/i.test(c.id);
}

export function isTimeColumn(c: GridColumn): boolean {
  return c.filter === "date" || /(?:^|[a-z])(?:At|Time|Date|Timestamp)$|^(?:at|time|date|timestamp|created|updated)$/.test(c.id);
}

function toNumber(value: unknown, c: GridColumn, now: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (isTimeColumn(c)) return toTime(value, now);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const money = parseMoney(text);
  if (money !== null) return isMoneyMicros(c) ? money : money / 1_000_000;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "$0.01" / "1 cent" / "2¢" / "0.5 cents" -> micros; null when the text isn't money. */
export function parseMoney(text: string): number | null {
  const cents = /^(\d+(?:\.\d+)?)\s*(?:¢|c|cents?)$/i.exec(text);
  if (cents) return Math.round(Number(cents[1]) * 10_000);
  if (/^\$\s?\d/.test(text) || /^\d+(?:\.\d+)?\s*(?:usd|dollars?)$/i.test(text)) {
    try {
      return dollarsToMicros(text.replace(/\s*(?:usd|dollars?)$/i, "").replace(/\s/g, ""));
    } catch {
      return null;
    }
  }
  return null;
}

/** "-1h", "30m", "2 days", "today", ISO, "YYYY-MM-DD HH:mm", epoch ms -> epoch ms. */
export function toTime(value: unknown, now: number): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value > 1e11 ? value : null;
  const text = String(value).trim().toLowerCase();
  const rel = /^(?:-|last\s+|past\s+)?\s*(\d+(?:\.\d+)?)?\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|weeks?)(?:\s+ago)?$/.exec(text);
  if (rel) {
    const n = rel[1] ? Number(rel[1]) : 1;
    const unit = rel[2] ?? "h";
    const ms = unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : unit.startsWith("d") ? 86_400_000 : 604_800_000;
    return now - n * ms;
  }
  if (text === "now") return now;
  if (text === "today" || text === "yesterday") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime() - (text === "yesterday" ? 86_400_000 : 0);
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})(?:[ t](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  if (local) {
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = local;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  }
  const parsed = Date.parse(String(value));
  if (Number.isFinite(parsed)) return parsed;
  const n = Number(text);
  return Number.isFinite(n) && n > 1e11 ? n : null;
}

/** AG Grid date filter format, local time: "2026-11-08 14:05:00". */
export function agDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function showNumber(n: number, c: GridColumn): string {
  return isMoneyMicros(c) ? formatUsd(Math.round(n)) : String(n);
}

/** "created in the last hour", "created before 2026-11-08 14:00:00", "with timestamp after ...". */
function timeText(name: string, op: string, from: number | null, to: number | null, now: number): string {
  const subject = name.endsWith(" at") ? name.slice(0, -3) : `with ${name}`;
  if (from === null) return `${subject} ${op === "blank" ? "missing" : "present"}`;
  const ago = now - from;
  const window =
    ago > 0 && ago % 60_000 === 0 && ago <= 28 * 86_400_000
      ? ago % 86_400_000 === 0
        ? plural(ago / 86_400_000, "day")
        : ago % 3_600_000 === 0
          ? plural(ago / 3_600_000, "hour")
          : plural(ago / 60_000, "minute")
      : null;
  if (op === "greaterThan" && window) return `${subject} in the last ${window.replace(/^1 /, "")}`;
  if (op === "lessThan" && window) return `${subject} more than ${window} ago`;
  if (op === "inRange" && to !== null) return `${subject} between ${agDate(from)} and ${agDate(to)}`;
  const word = op === "greaterThan" ? "after" : op === "lessThan" ? "before" : op === "notEqual" ? "not on" : "on";
  return `${subject} ${word} ${agDate(from)}`;
}
