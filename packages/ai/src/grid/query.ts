/**
 * "Ask the ledger" (AG Grid AI Toolkit): question + structured schema + current state -> new state for
 * `gridApi.setState(state, propertiesToIgnore)` and a one-line explanation. The model answers with a small
 * plan constrained to the grid's column ids; the rules planner covers the mock and model failures.
 */
import type { LlmClient, LlmMessage } from "@p402/gateway/context";
import type { GridQueryRequestDTO, GridQueryResponseDTO } from "@p402/shared";
import { z } from "zod";
import { isRecord } from "../llm/schema";
import { listJoin, truncate } from "../util/text";
import { agDate, explainPlan, FILTER_OPS, type GridPlan, isTimeColumn, planToState } from "./plan";
import { planFromRules } from "./rules";
import { type GridColumn, type GridSchemaSummary, summarizeGridSchema } from "./schema";

export const GRID_TIMEOUT_MS = 30_000;

export async function gridQuery(llm: LlmClient, request: GridQueryRequestDTO, now: number): Promise<GridQueryResponseDTO> {
  const grid = summarizeGridSchema(request.schema);
  const current = isRecord(request.state) ? request.state : {};
  const question = truncate(request.question.trim(), 500);

  if (question === "") return respond(null, grid, current, now, llm.model);
  if (llm.provider === "mock") return respond(planFromRules(question, grid), grid, current, now, llm.model);

  try {
    const plan = await llm.json(gridMessages(question, grid, current, now), planSchema(grid), {
      timeoutMs: GRID_TIMEOUT_MS,
      maxTokens: 400,
      temperature: 0,
    });
    return respond(plan, grid, current, now, llm.model);
  } catch {
    const fallback = planFromRules(question, grid);
    const response = respond(fallback, grid, current, now, "rules");
    return { ...response, explanation: `${response.explanation} (The model was unavailable, so simple rules answered.)` };
  }
}

function respond(
  plan: GridPlan | null,
  grid: GridSchemaSummary,
  current: Record<string, unknown>,
  now: number,
  model: string,
): GridQueryResponseDTO {
  if (!plan) {
    const examples = ["voided calls", "by seller", "most expensive", "reviews seller", "last hour", "group by task"];
    return {
      state: current,
      propertiesToIgnore: planToState(emptyPlan(), grid, current, now).propertiesToIgnore,
      explanation: `I couldn't map that question to the grid. Try: ${listJoin(examples.map((e) => `“${e}”`))}.`,
      model,
    };
  }
  const planned = planToState(plan, grid, current, now);
  return { state: planned.state, propertiesToIgnore: planned.propertiesToIgnore, explanation: explainPlan(planned, plan.reset), model };
}

function emptyPlan(): GridPlan {
  return { filters: [], sort: [], groupBy: [], aggregate: [], reset: false };
}

function planSchema(grid: GridSchemaSummary) {
  const ids = grid.columns.map((c) => c.id);
  const colId = ids.length > 0 ? z.enum(ids as [string, ...string[]]) : z.string();
  const value = z.union([z.string(), z.number()]).nullable().optional();
  return z.object({
    filters: z
      .array(z.object({ colId, op: z.enum(FILTER_OPS), value, valueTo: value, values: z.array(z.string()).max(20).optional() }))
      .max(8),
    sort: z.array(z.object({ colId, dir: z.enum(["asc", "desc"]) })).max(4),
    groupBy: z.array(colId).max(4),
    aggregate: z.array(z.object({ colId, func: z.string() })).max(6),
    reset: z.boolean(),
    explanation: z.string().max(400),
  });
}

export function gridMessages(question: string, grid: GridSchemaSummary, current: Record<string, unknown>, now: number): LlmMessage[] {
  const system = [
    "You turn questions about a grid of paid API calls (vouchers) into grid settings, as JSON.",
    "Columns (id: filter type [values]; sortable, groupable, aggregations):",
    ...grid.columns.map(describeColumn),
    `Now: ${agDate(now)}.`,
    `Current view: ${describeState(current)}.`,
    "Fields:",
    "- filters: [{colId, op, value, valueTo, values}]. op: in (set columns, list values), equals, notEqual, contains, greaterThan, lessThan, inRange (value to valueTo), blank, notBlank.",
    '  Money: write dollars like "$0.01". Times: write "-1h", "-30m", "-2d" (before now) or "2026-11-08 14:00".',
    "- sort: [{colId, dir}] with dir asc or desc. groupBy: [colId]. aggregate: [{colId, func}].",
    "- reset: true to start from a clean view, false to change only what the question mentions.",
    "- explanation: one short sentence.",
    "Use only the column ids listed above.",
  ].join("\n");
  const messages: LlmMessage[] = [{ role: "system", content: system }];
  const example = examplePlan(grid);
  if (example) messages.push({ role: "user", content: example.question }, { role: "assistant", content: JSON.stringify(example.plan) });
  messages.push({ role: "user", content: question });
  return messages;
}

function describeColumn(c: GridColumn): string {
  const parts: string[] = [];
  if (c.filter) {
    const kind = c.filter === "multi" ? `multi (${(c.multi ?? []).join(" + ")})` : c.filter;
    parts.push(c.values?.length ? `${kind} [${c.values.join(", ")}]` : kind);
  } else parts.push("no filter");
  if (/micros/i.test(c.id)) parts.push("money in micro-dollars, write dollars");
  else if (isTimeColumn(c)) parts.push("time");
  if (c.sortable) parts.push("sortable");
  if (c.groupable) parts.push("groupable");
  if (c.aggFuncs.length > 0) parts.push(`agg ${c.aggFuncs.join("/")}`);
  return `- ${c.id}${c.description ? ` (${truncate(c.description, 60)})` : ""}: ${parts.join(", ")}`;
}

/** "filter status in [voided]; sort priceMicros desc; group by sellerId" */
export function describeState(state: Record<string, unknown>): string {
  const parts: string[] = [];
  const filterModel = isRecord(state.filter) && isRecord(state.filter.filterModel) ? state.filter.filterModel : {};
  const filters = Object.entries(filterModel).map(([id, model]) => `${id} ${describeFilterModel(model)}`);
  if (filters.length) parts.push(`filter ${filters.join(" and ")}`);
  const sortModel = isRecord(state.sort) && Array.isArray(state.sort.sortModel) ? state.sort.sortModel : [];
  const sorts = sortModel.filter(isRecord).map((s) => `${String(s.colId)} ${String(s.sort)}`);
  if (sorts.length) parts.push(`sort ${sorts.join(", ")}`);
  const groups = isRecord(state.rowGroup) && Array.isArray(state.rowGroup.groupColIds) ? state.rowGroup.groupColIds.map(String) : [];
  if (groups.length) parts.push(`group by ${groups.join(", ")}`);
  return truncate(parts.join("; ") || "no filters, sorting or grouping", 600);
}

function describeFilterModel(model: unknown): string {
  if (!isRecord(model)) return "?";
  if (Array.isArray(model.values)) return `in [${model.values.map(String).join(", ")}]`;
  if (Array.isArray(model.conditions)) {
    return model.conditions.map(describeFilterModel).join(` ${String(model.operator ?? "AND").toLowerCase()} `);
  }
  if (Array.isArray(model.filterModels)) {
    return model.filterModels.filter((m) => m !== null).map(describeFilterModel).join(" and ");
  }
  const from = model.filter ?? model.dateFrom;
  const to = model.filterTo ?? model.dateTo;
  const parts = [String(model.type ?? "?")];
  if (from !== undefined && from !== null) parts.push(String(from));
  if (to !== undefined && to !== null) parts.push(`to ${String(to)}`);
  return parts.join(" ");
}

/** A one-shot example built from this grid's own columns, when it has suitable ones. */
function examplePlan(grid: GridSchemaSummary): { question: string; plan: GridPlan & { explanation: string } } | null {
  const status = grid.columns.find((c) => /status/i.test(c.id) && c.filter === "set");
  const group = grid.columns.find((c) => c.groupable && c !== status);
  const voided = status?.values?.find((v) => /void/i.test(v)) ?? (status && !status.values ? "voided" : undefined);
  if (!status || !group || !voided) return null;
  return {
    question: `voided calls by ${group.id}`,
    plan: {
      filters: [{ colId: status.id, op: "in", values: [voided] }],
      sort: [],
      groupBy: [group.id],
      aggregate: [],
      reset: true,
      explanation: `Voided calls grouped by ${group.id}.`,
    },
  };
}
