/**
 * Rule-based grid planner for the offline mock and for when the model is unavailable. Understands the demo's
 * questions: "voided", "by seller", "most expensive", "reviews seller", "last hour", "group by task",
 * "over 1 cent", "reset". Column ids always come from the grid's schema.
 */
import type { GridPlan } from "./plan";
import { isTimeColumn, parseMoney } from "./plan";
import type { GridColumn, GridSchemaSummary } from "./schema";

/** Seller ids of the demo catalog, used when the grid doesn't share its set filter values. */
const DEMO_SELLERS = ["channel3", "pricewatch", "reviews"];

export function planFromRules(question: string, grid: GridSchemaSummary): GridPlan | null {
  const q = question.toLowerCase();
  const find = (re: RegExp, ok: (c: GridColumn) => boolean = () => true) =>
    grid.columns.find((c) => re.test(c.id) && ok(c)) ?? grid.columns.find((c) => !!c.description && re.test(c.description) && ok(c));
  const status = find(/status/i, (c) => !!c.filter);
  const seller = find(/seller/i);
  const price = find(/price|cost|amount|micros/i, (c) => !isTimeColumn(c));
  const time = find(/created|^at$|At$|time|date/i, isTimeColumn);
  const latency = find(/latency|duration/i);
  const groupWords: Record<string, GridColumn | undefined> = {
    seller,
    agent: find(/agent/i),
    task: find(/task/i),
    status,
    reason: find(/reason/i),
    endpoint: find(/endpoint|path/i),
  };

  const plan: GridPlan = {
    filters: [],
    sort: [],
    groupBy: [],
    aggregate: [],
    reset: !/\b(?:also|too|as well|additionally|and then|now)\b/.test(q),
  };
  let matched = false;

  if (/\b(?:reset|clear|start over|show (?:me )?(?:all|everything)|all (?:calls|vouchers|rows))\b/.test(q)) {
    plan.reset = true;
    matched = true;
  }

  if (status?.filter) {
    if (/\bvoid(?:ed|s)?\b|\bfail(?:ed|ures?|ing)?\b|\brejected\b|\bbad\b|\brefund(?:ed)?\b/.test(q)) {
      plan.filters.push({ colId: status.id, op: "in", values: ["voided"] });
      matched = true;
    } else if (/\baccepted\b|\bsuccess(?:ful)?\b|\bbillable\b|\bpaid\b|\bgood\b/.test(q)) {
      plan.filters.push({ colId: status.id, op: "in", values: ["accepted"] });
      matched = true;
    }
  }

  if (seller?.filter) {
    const squashed = q.replace(/[^a-z0-9]/g, "");
    const named = (seller.values?.length ? seller.values : DEMO_SELLERS).filter((v) => {
      const lower = v.toLowerCase();
      return new RegExp(`\\b${escapeRe(lower)}\\b`).test(q) || (lower.length >= 6 && squashed.includes(lower.replace(/[^a-z0-9]/g, "")));
    });
    if (named.length > 0) {
      plan.filters.push({ colId: seller.id, op: "in", values: named });
      matched = true;
    }
  }

  for (const match of q.matchAll(/\b(?:by|per|for each|each|group(?:ed)?\s+by)\s+(seller|agent|task|status|reason|endpoint|path)s?\b/g)) {
    const c = groupWords[match[1] === "path" ? "endpoint" : (match[1] ?? "")];
    if (c?.groupable && !plan.groupBy.includes(c.id)) {
      plan.groupBy.push(c.id);
      matched = true;
    }
  }

  if (price?.sortable) {
    if (/most expensive|priciest|highest (?:price|cost)|biggest|largest|\bexpensive\b/.test(q)) {
      plan.sort.push({ colId: price.id, dir: "desc" });
      matched = true;
    } else if (/cheapest|lowest (?:price|cost)|least expensive/.test(q)) {
      plan.sort.push({ colId: price.id, dir: "asc" });
      matched = true;
    }
  }
  if (latency?.sortable && /slowest|fastest|latency/.test(q)) {
    plan.sort.push({ colId: latency.id, dir: /fastest/.test(q) ? "asc" : "desc" });
    matched = true;
  }
  if (time?.sortable && /newest|latest|most recent|\brecent\b|oldest|earliest/.test(q)) {
    plan.sort.push({ colId: time.id, dir: /oldest|earliest/.test(q) ? "asc" : "desc" });
    matched = true;
  }

  if (time?.filter) {
    const window = /\b(?:last|past|previous)\s+(\d+\s*)?(minute|min|hour|hr|day|week)s?\b/.exec(q);
    if (window) {
      plan.filters.push({ colId: time.id, op: "greaterThan", value: `-${(window[1] ?? "1").trim()}${(window[2] ?? "h")[0]}` });
      matched = true;
    } else if (/\btoday\b/.test(q)) {
      plan.filters.push({ colId: time.id, op: "greaterThan", value: "today" });
      matched = true;
    }
  }

  if (price?.filter) {
    const amount = String.raw`(\$\s?\d+(?:\.\d+)?|\d+(?:\.\d+)?\s*(?:¢|cents?))`;
    const over = new RegExp(String.raw`(?:over|above|more than|greater than|at least|>)\s*${amount}`).exec(q);
    const under = new RegExp(String.raw`(?:under|below|less than|cheaper than|<)\s*${amount}`).exec(q);
    for (const [m, op] of [
      [over, "greaterThan"],
      [under, "lessThan"],
    ] as const) {
      if (m?.[1] && parseMoney(m[1].replace(/\s+/g, " ").trim()) !== null) {
        plan.filters.push({ colId: price.id, op, value: m[1].replace(/\s+/g, "") });
        matched = true;
      }
    }
  }

  if (price && plan.groupBy.length > 0 && /\b(?:total|sum|spend|spent|how much|cost)\b/.test(q)) {
    const sum = price.aggFuncs.find((f) => f.toLowerCase() === "sum");
    if (sum) plan.aggregate.push({ colId: price.id, func: sum });
  }

  return matched ? plan : null;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
