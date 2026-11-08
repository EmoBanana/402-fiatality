/**
 * Reads the AG Grid AI Toolkit structured schema (`gridApi.getStructuredSchema()`, a JSON Schema of the grid
 * state sections the grid supports) into a compact column list: ids, filter types and values, and what each
 * column allows. That summary, not the raw schema, goes into the prompt for Gemma 4 12B.
 */
import { isRecord } from "../llm/schema";
import { truncate } from "../util/text";

export type FilterKind = "set" | "text" | "number" | "date" | "bigint" | "boolean";

export interface GridColumn {
  id: string;
  description?: string;
  filter?: FilterKind | "multi";
  /** Child filter kinds of a multi filter, in order. */
  multi?: FilterKind[];
  /** Operators the filter offers (text, number, date filters). */
  ops?: string[];
  /** Set filter values, when the grid shares them (`includeSetValues`). */
  values?: string[];
  sortable: boolean;
  groupable: boolean;
  aggFuncs: string[];
  pivotable: boolean;
}

export interface GridSchemaSummary {
  columns: GridColumn[];
  features: {
    filter: boolean;
    advancedFilter: boolean;
    sort: boolean;
    rowGroup: boolean;
    aggregation: boolean;
    columnVisibility: boolean;
    pivot: boolean;
  };
}

const MAX_COLUMNS = 80;
const MAX_VALUES = 30;

export function summarizeGridSchema(schema: unknown): GridSchemaSummary {
  const root = isRecord(schema) ? schema : {};
  const props = rec(root.properties);
  const columns = new Map<string, GridColumn>();
  const col = (id: string): GridColumn | undefined => {
    if (typeof id !== "string" || id === "" || id.length > 100) return undefined;
    let c = columns.get(id);
    if (!c && columns.size < MAX_COLUMNS) {
      c = { id, sortable: false, groupable: false, aggFuncs: [], pivotable: false };
      columns.set(id, c);
    }
    return c;
  };

  const all = rec(deref(rec(root.$defs).allColumnIds, root));
  // `_enum`: the schema builder object itself, when the client skipped JSON serialization.
  for (const id of strings(all.enum ?? all._enum)) col(id);
  if (typeof all.description === "string") {
    for (const line of all.description.split("\n")) {
      const i = line.indexOf(": ");
      if (i > 0) {
        const c = columns.get(line.slice(0, i).trim());
        if (c) c.description = truncate(line.slice(i + 2).trim(), 120);
      }
    }
  }

  const filter = rec(rec(props.filter).properties);
  const filterModel = rec(deref(filter.filterModel, root));
  for (const [id, node] of Object.entries(rec(filterModel.properties))) {
    const c = col(id);
    if (c) Object.assign(c, filterInfo(node, root));
  }

  const sortIds = strings(dig(props, root, "sort", "sortModel", "items", "colId").enum);
  for (const id of sortIds) {
    const c = col(id);
    if (c) c.sortable = true;
  }

  const groupIds = strings(rec(deref(rec(dig(props, root, "rowGroup", "groupColIds")).items, root)).enum);
  for (const id of groupIds) {
    const c = col(id);
    if (c) c.groupable = true;
  }

  const aggItems = rec(deref(dig(props, root, "aggregation", "aggregationModel").items, root));
  for (const option of variants(aggItems, root)) {
    const p = rec(option.properties);
    const id = strings(rec(deref(p.colId, root)).enum)[0];
    const c = id ? col(id) : undefined;
    if (c) c.aggFuncs = strings(rec(deref(p.aggFunc, root)).enum);
  }

  const pivotIds = strings(rec(deref(rec(dig(props, root, "pivot", "pivotColIds")).items, root)).enum);
  for (const id of pivotIds) {
    const c = col(id);
    if (c) c.pivotable = true;
  }

  return {
    columns: [...columns.values()],
    features: {
      filter: "filterModel" in filter,
      advancedFilter: "advancedFilterModel" in filter,
      sort: sortIds.length > 0,
      rowGroup: groupIds.length > 0,
      aggregation: [...columns.values()].some((c) => c.aggFuncs.length > 0),
      columnVisibility: "columnVisibility" in props,
      pivot: pivotIds.length > 0,
    },
  };
}

/** Filter type, operators and set values of one column's filter schema. */
function filterInfo(node: unknown, root: Record<string, unknown>): Partial<GridColumn> {
  const schema = rec(deref(node, root));
  const p = rec(schema.properties);
  const kind = strings(rec(p.filterType).enum)[0];
  if (kind === "multi") {
    const children = variants(rec(deref(rec(p.filterModels).items, root)), root).map((child) => filterInfo(child, root));
    const kinds = children.map((c) => c.filter).filter((k): k is FilterKind => !!k && k !== "multi");
    return {
      filter: "multi",
      multi: kinds,
      values: children.find((c) => c.filter === "set")?.values,
      ops: children.find((c) => c.filter !== "set")?.ops,
    };
  }
  if (kind === "set") {
    const values = strings(rec(deref(rec(p.values).items, root)).enum)
      .slice(0, MAX_VALUES)
      .map((v) => truncate(v, 60));
    return { filter: "set", ...(values.length ? { values } : {}) };
  }
  if (!kind || !["text", "number", "date", "bigint", "boolean"].includes(kind)) return {};
  let ops = strings(rec(p.type).enum);
  if (ops.length === 0) {
    // Join form: { filterType, operator, conditions: [simple model, ...] }
    const condition = rec(deref(rec(p.conditions).items, root));
    ops = strings(rec(rec(condition.properties).type).enum);
  }
  return { filter: kind as FilterKind, ...(ops.length ? { ops } : {}) };
}

/** `{ anyOf: [...] }` members, or the node itself. */
function variants(node: Record<string, unknown>, root: Record<string, unknown>): Record<string, unknown>[] {
  const list = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : [node];
  return list.map((v) => rec(deref(v, root))).filter((v) => v.type !== "null" && Object.keys(v).length > 0);
}

/** Walk feature -> property -> ... through `properties`, `items` and $refs. */
function dig(props: Record<string, unknown>, root: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let node: Record<string, unknown> = rec(deref(props[path[0] ?? ""], root));
  for (const key of path.slice(1)) {
    const next = key === "items" ? node.items : rec(node.properties)[key];
    node = rec(deref(next, root));
  }
  return node;
}

function deref(node: unknown, root: Record<string, unknown>, depth = 0): unknown {
  if (!isRecord(node) || typeof node.$ref !== "string" || depth > 8) return node;
  const ref = node.$ref;
  if (!ref.startsWith("#/")) return {};
  let target: unknown = root;
  for (const part of ref.slice(2).split("/")) target = isRecord(target) ? target[part] : undefined;
  return deref(target, root, depth + 1);
}

function rec(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
