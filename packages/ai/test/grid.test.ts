import { readFileSync } from "node:fs";
import type { GridQueryRequestDTO } from "@p402/shared";
import { afterEach, describe, expect, it } from "vitest";
import { agDate } from "../src/grid/plan";
import { gridQuery } from "../src/grid/query";
import { summarizeGridSchema } from "../src/grid/schema";
import { createLlm } from "../src/llm";
import { createMockLlm } from "../src/llm/mock";
import { downServerUrl, type FakeHandler, type FakeServer, ollamaReply, startFakeServer } from "./helpers/fake-llm-server";

/** Captured from AG Grid Enterprise 36.3 in Chromium: getStructuredSchema() and getState() of a voucher grid. */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/voucher-grid.json", import.meta.url), "utf8")) as {
  schema: Record<string, unknown>;
  state: Record<string, unknown>;
  filteredState: Record<string, unknown>;
};

const NOW = new Date(2026, 10, 8, 15, 30, 0).getTime();
const ollama = (baseUrl: string) => createLlm({ provider: "ollama", baseUrl, model: "gemma4:12b", apiKey: null });
const ask = (question: string, state = fixture.state): GridQueryRequestDTO => ({ question, schema: fixture.schema, state });

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fake(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}

describe("summarizeGridSchema", () => {
  it("reads columns, filter types, set values and capabilities from a real AG Grid schema", () => {
    const grid = summarizeGridSchema(fixture.schema);
    const col = (id: string) => grid.columns.find((c) => c.id === id)!;

    expect(grid.columns.map((c) => c.id)).toEqual(["id", "sellerId", "status", "voidReason", "priceMicros", "createdAt", "taskId", "agentId", "path", "latencyMs"]);
    expect(col("sellerId")).toMatchObject({ filter: "set", values: ["channel3", "reviews", "pricewatch"], groupable: true, sortable: true, description: "Seller paid for the call" });
    expect(col("status")).toMatchObject({ filter: "set", values: ["accepted", "voided"] });
    expect(col("agentId").filter).toBe("set");
    expect(col("agentId").values).toBeUndefined();
    expect(col("priceMicros")).toMatchObject({ filter: "number", groupable: false });
    expect(col("priceMicros").ops).toContain("greaterThan");
    expect(col("priceMicros").aggFuncs).toContain("sum");
    expect(col("createdAt").filter).toBe("date");
    expect(col("id").filter).toBe("text");
    expect(col("taskId")).toMatchObject({ filter: "multi", multi: ["text", "set"], groupable: true });
    expect(grid.features).toMatchObject({ filter: true, advancedFilter: false, sort: true, rowGroup: true, aggregation: true, columnVisibility: true, pivot: false });
  });

  it("survives junk input", () => {
    expect(summarizeGridSchema(null).columns).toEqual([]);
    expect(summarizeGridSchema({ properties: { filter: 3 } }).features.filter).toBe(false);
  });
});

describe("rule-based grid queries (mock provider)", () => {
  const ai = { gridQuery: (request: GridQueryRequestDTO) => gridQuery(createMockLlm(), request, NOW) };

  it("“voided” filters the status set filter and leaves other state alone", async () => {
    const out = await ai.gridQuery(ask("show voided calls"));
    expect(out.model).toBe("mock");
    expect(out.state.filter).toEqual({ filterModel: { status: { filterType: "set", values: ["voided"] } } });
    expect(out.state.rowGroup).toEqual({ groupColIds: [] });
    expect(out.propertiesToIgnore).not.toContain("filter");
    expect(out.propertiesToIgnore).not.toContain("rowGroup");
    expect(out.propertiesToIgnore).toEqual(expect.arrayContaining(["sort", "columnOrder", "columnSizing", "aggregation", "scroll", "rowSelection"]));
    expect(out.propertiesToIgnore).not.toContain("version");
    expect(out.state.version).toBe("36.3.0");
    expect(out.state.sort).toEqual(fixture.state.sort);
    expect(out.explanation).toBe("Showing calls where status is voided.");
  });

  it("“by seller” groups rows", async () => {
    const out = await ai.gridQuery(ask("spend by seller"));
    expect(out.state.rowGroup).toEqual({ groupColIds: ["sellerId"] });
    expect(out.state.aggregation).toEqual({ aggregationModel: [{ colId: "priceMicros", aggFunc: "sum" }] });
    expect(out.explanation).toBe("Showing calls grouped by seller, with the sum of price.");
  });

  it("“most expensive” sorts by price, highest first", async () => {
    const out = await ai.gridQuery(ask("most expensive calls"));
    expect(out.state.sort).toEqual({ sortModel: [{ colId: "priceMicros", sort: "desc", type: "default" }] });
    expect(out.explanation).toMatch(/sorted by price \(highest first\)/);
  });

  it("“reviews seller” filters to that seller", async () => {
    const out = await ai.gridQuery(ask("what did the reviews seller return?"));
    expect(out.state.filter).toEqual({ filterModel: { sellerId: { filterType: "set", values: ["reviews"] } } });
  });

  it("“last hour” filters the date column relative to the clock", async () => {
    const out = await ai.gridQuery(ask("calls in the last hour"));
    expect(out.state.filter).toEqual({
      filterModel: { createdAt: { filterType: "date", type: "greaterThan", dateFrom: agDate(NOW - 3_600_000), dateTo: null } },
    });
    expect(out.explanation).toBe("Showing calls created in the last hour.");
  });

  it("“group by task” groups by the task column", async () => {
    expect((await ai.gridQuery(ask("group by task"))).state.rowGroup).toEqual({ groupColIds: ["taskId"] });
  });

  it("combines filters, grouping and money thresholds", async () => {
    const out = await ai.gridQuery(ask("voided calls over 1 cent by seller"));
    expect(out.state.filter).toEqual({
      filterModel: {
        status: { filterType: "set", values: ["voided"] },
        priceMicros: { filterType: "number", type: "greaterThan", filter: 10_000 },
      },
    });
    expect(out.state.rowGroup).toEqual({ groupColIds: ["sellerId"] });
    expect(out.explanation).toBe("Showing calls where status is voided and price is above $0.01, grouped by seller.");
  });

  it("follow-ups keep the current view", async () => {
    const out = await ai.gridQuery(ask("now sort by most expensive", fixture.filteredState));
    expect(out.propertiesToIgnore).toContain("filter");
    expect(out.propertiesToIgnore).toContain("rowGroup");
    expect(out.state.filter).toEqual(fixture.filteredState.filter);
    expect(out.state.sort).toEqual({ sortModel: [{ colId: "priceMicros", sort: "desc", type: "default" }] });
  });

  it("“reset” clears filters, grouping and sorting", async () => {
    const out = await ai.gridQuery(ask("reset", fixture.filteredState));
    expect(out.state).toMatchObject({ filter: { filterModel: {} }, rowGroup: { groupColIds: [] }, sort: { sortModel: [] } });
    expect(out.explanation).toBe("Cleared the filters, sorting and grouping.");
  });

  it("leaves the grid unchanged for questions it can't map", async () => {
    const out = await ai.gridQuery(ask("what is the meaning of life?"));
    expect(out.state).toEqual(fixture.state);
    expect(out.propertiesToIgnore).toEqual(expect.arrayContaining(["filter", "sort", "rowGroup", "aggregation"]));
    expect(out.explanation).toMatch(/couldn't map.*“voided calls”/);
  });
});

describe("LLM grid queries (fake Ollama)", () => {
  const plan = (p: Record<string, unknown>) => () =>
    ollamaReply(JSON.stringify({ filters: [], sort: [], groupBy: [], aggregate: [], reset: false, explanation: "ok", ...p }));

  it("sends a compact prompt and constrains column ids to the grid's", async () => {
    const server = await fake(plan({ filters: [{ colId: "status", op: "in", values: ["Voided"] }], groupBy: ["sellerId"], reset: true }));
    const out = await gridQuery(ollama(server.url), ask("voided by seller"), NOW);

    expect(out.model).toBe("gemma4:12b");
    expect(out.state.filter).toEqual({ filterModel: { status: { filterType: "set", values: ["voided"] } } });
    expect(out.state.rowGroup).toEqual({ groupColIds: ["sellerId"] });

    const body = server.requests[0]!.body;
    const system = body.messages[0].content as string;
    expect(system.length).toBeLessThan(3_000);
    expect(system).toContain("- status (accepted or voided): set [accepted, voided], sortable, groupable");
    expect(system).toContain("- priceMicros (Price in micro-dollars (1 cent = 10000)): number, money in micro-dollars, write dollars");
    expect(system).toContain(`Now: ${agDate(NOW)}.`);
    expect(body.messages.at(-1).content).toBe("voided by seller");
    expect(body.format.properties.filters.items.properties.colId.enum).toEqual(expect.arrayContaining(["status", "priceMicros"]));
  });

  it("builds multi, number and date filters from dollars and relative times", async () => {
    const server = await fake(
      plan({
        filters: [
          { colId: "taskId", op: "contains", value: "espresso" },
          { colId: "priceMicros", op: "greaterThan", value: "$0.005" },
          { colId: "createdAt", op: "greaterThan", value: "-30m" },
          { colId: "latencyMs", op: "inRange", value: 100, valueTo: 500 },
        ],
      }),
    );
    const out = await gridQuery(ollama(server.url), ask("espresso tasks"), NOW);
    expect((out.state.filter as { filterModel: Record<string, unknown> }).filterModel).toEqual({
      taskId: { filterType: "multi", filterModels: [{ filterType: "text", type: "contains", filter: "espresso" }, null] },
      priceMicros: { filterType: "number", type: "greaterThan", filter: 5_000 },
      createdAt: { filterType: "date", type: "greaterThan", dateFrom: agDate(NOW - 1_800_000), dateTo: null },
      latencyMs: { filterType: "number", type: "inRange", filter: 100, filterTo: 500 },
    });
  });

  it("skips plan items the grid can't do, keeps those sections and says so", async () => {
    const server = await fake(plan({ groupBy: ["priceMicros"], sort: [{ colId: "status", dir: "asc" }] }));
    const out = await gridQuery(ollama(server.url), ask("group by price", fixture.filteredState), NOW);
    expect(out.state.sort).toEqual({ sortModel: [{ colId: "status", sort: "asc", type: "default" }] });
    expect(out.state.rowGroup).toEqual(fixture.filteredState.rowGroup);
    expect(out.propertiesToIgnore).toContain("rowGroup");
    expect(out.explanation).toBe("Showing calls sorted by status (lowest first). Skipped: grouping by priceMicros.");
  });

  it("changes nothing when every plan item is unusable", async () => {
    const server = await fake(plan({ reset: true, filters: [{ colId: "status", op: "in", values: ["refunded"] }] }));
    const out = await gridQuery(ollama(server.url), ask("refunded calls", fixture.filteredState), NOW);
    expect(out.state).toEqual(fixture.filteredState);
    expect(out.propertiesToIgnore).toEqual(expect.arrayContaining(["filter", "rowGroup", "sort"]));
    expect(out.explanation).toMatch(/couldn't map.*Skipped: filter on status/);
  });

  it("falls back to the rules when the model is down", async () => {
    const out = await gridQuery(ollama(await downServerUrl()), ask("voided calls"), NOW);
    expect(out.model).toBe("rules");
    expect(out.state.filter).toEqual({ filterModel: { status: { filterType: "set", values: ["voided"] } } });
    expect(out.explanation).toMatch(/model was unavailable/);
  });
});
