import { createPublicKey } from "node:crypto";
import type { AgentRunDTO, AgentStepDTO, GatewayEvent } from "@p402/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunOptions, AgentRunResult, RunAgent } from "../src/context";
import { coreOf } from "../src/core";
import { createHarness, injectJson, openTab, sleep, type Harness } from "./helpers";

/** A controllable fake agent: emits the steps it is told to, finishes when released or aborted. */
function controllableAgent() {
  const runs: AgentRunOptions[] = [];
  const releases = new Map<string, (result?: Partial<AgentRunResult>) => void>();
  const runAgent: RunAgent = (opts) => {
    runs.push(opts);
    return new Promise<AgentRunResult>((resolve, reject) => {
      const done = (result: Partial<AgentRunResult> = {}) => resolve({ status: "finished", summary: "done", spentMicros: 0, ...result });
      releases.set(opts.runId, done);
      opts.signal?.addEventListener("abort", () => resolve({ status: "stopped", summary: "stopped by user", spentMicros: 0 }), { once: true });
      if (opts.task === "explode") reject(new Error("agent crashed"));
    });
  };
  return { runAgent, runs, release: (runId: string, result?: Partial<AgentRunResult>) => releases.get(runId)?.(result) };
}

let h: Harness;
afterEach(async () => {
  await h.close();
});

describe("agent runs", () => {
  it("creates a key pair, registers it on the tab and starts the agent without blocking", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent, gatewayUrl: () => "http://127.0.0.1:4199" });
    const { tabId } = await openTab(h);
    const created = await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId, task: "Find a quiet espresso machine", mode: "scripted", maxSteps: 12 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ tabId, status: "running", mode: "scripted", task: "Find a quiet espresso machine", steps: [], spentMicros: 0 });

    const opts = agent.runs[0]!;
    expect(opts).toMatchObject({
      runId: created.body.id,
      gatewayUrl: "http://127.0.0.1:4199",
      tabId,
      agentId: created.body.agentId,
      task: "Find a quiet espresso machine",
      mode: "scripted",
      maxSteps: 12,
      taskId: created.body.id,
      apiHeaders: undefined,
    });
    expect(opts.llm).toBe(h.ctx.ai.llm);
    expect(opts.signal?.aborted).toBe(false);
    const registered = h.ctx.db.prepare("SELECT public_key FROM agent_keys WHERE tab_id = ? AND agent_id = ?").get(tabId, opts.agentId) as {
      public_key: string;
    };
    const jwk = JSON.parse(opts.privateKey) as { x: string; d: string };
    expect(jwk.x).toBe(registered.public_key);
    expect(createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: registered.public_key }, format: "jwk" }).asymmetricKeyType).toBe("ed25519");
    agent.release(created.body.id);
  });

  it("persists and emits steps, then the result", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent });
    const { tabId } = await openTab(h);
    const events: GatewayEvent[] = [];
    h.ctx.bus.subscribe((e) => events.push(e));
    const run = (await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId, task: "t", mode: "llm" })).body;
    const opts = agent.runs[0]!;
    const step = (s: Partial<AgentStepDTO>) => opts.onStep({ runId: "spoofed", index: 99, kind: "thought", text: "", at: 5, ...s });
    step({ kind: "thought", text: "Is this worth $0.005? Yes." });
    step({ kind: "paid_call", text: "search", costMicros: 5_000, cumulativeMicros: 5_000, sellerId: "acme", status: "accepted" });
    step({ kind: "paid_call", text: "reviews", costMicros: 3_000, cumulativeMicros: 3_000, sellerId: "acme", status: "voided", voidReason: "upstream_5xx" });
    agent.release(run.id, { summary: "Buy the Brevia 2", spentMicros: 5_000, purchaseId: "pur_1" });
    await coreOf(h.ctx).agents.idle();

    const full = (await injectJson<AgentRunDTO>(h.app, "GET", `/api/agent/runs/${run.id}`)).body;
    expect(full).toMatchObject({ status: "finished", spentMicros: 5_000, result: { summary: "Buy the Brevia 2", purchaseId: "pur_1" }, error: null });
    expect(full.steps.map((s) => [s.index, s.kind, s.runId])).toEqual([
      [0, "thought", run.id],
      [1, "paid_call", run.id],
      [2, "paid_call", run.id],
    ]);
    expect(full.steps[2]).toMatchObject({ voidReason: "upstream_5xx", status: "voided", costMicros: 3_000 });
    expect(full.finishedAt).toBeTypeOf("number");
    expect(events.filter((e) => e.type === "agent.step")).toHaveLength(3);
    const finished = events.find((e) => e.type === "agent.finished") as Extract<GatewayEvent, { type: "agent.finished" }>;
    expect(finished.data.steps).toHaveLength(3);

    const listed = (await injectJson<AgentRunDTO[]>(h.app, "GET", `/api/agent/runs?tabId=${tabId}`)).body;
    expect(listed).toEqual([expect.objectContaining({ id: run.id, steps: [] })]);
    expect((await injectJson<AgentRunDTO[]>(h.app, "GET", "/api/agent/runs?tabId=tab_other")).body).toEqual([]);
  });

  it("stops a run by aborting its signal", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent });
    const { tabId } = await openTab(h);
    const run = (await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId, task: "t", mode: "runaway" })).body;
    const stopped = await injectJson<AgentRunDTO>(h.app, "POST", `/api/agent/runs/${run.id}/stop`);
    expect(agent.runs[0]!.signal?.aborted).toBe(true);
    expect(stopped.body).toMatchObject({ status: "stopped", result: { summary: "stopped by user" } });
    expect((await injectJson<AgentRunDTO>(h.app, "POST", `/api/agent/runs/${run.id}/stop`)).body.status).toBe("stopped");
    expect((await injectJson(h.app, "POST", "/api/agent/runs/run_missing/stop")).status).toBe(404);
    expect((await injectJson(h.app, "GET", "/api/agent/runs/run_missing")).status).toBe(404);
  });

  it("runs at most 3 agents at once and only on active tabs", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent });
    const { tabId } = await openTab(h);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId, task: `t${i}`, mode: "scripted" })).body.id);
    const fourth = await injectJson(h.app, "POST", "/api/agent/runs", { tabId, task: "t4", mode: "scripted" });
    expect(fourth).toMatchObject({ status: 409, body: { error: "too_many_runs" } });
    agent.release(ids[0]!);
    await sleep(10);
    expect((await injectJson(h.app, "POST", "/api/agent/runs", { tabId, task: "t5", mode: "scripted" })).status).toBe(201);

    for (const opts of agent.runs) agent.release(opts.runId);
    await coreOf(h.ctx).agents.idle();
    h.ctx.db.prepare("UPDATE tabs SET status = 'paused' WHERE id = ?").run(tabId);
    expect((await injectJson(h.app, "POST", "/api/agent/runs", { tabId, task: "t", mode: "scripted" })).body).toMatchObject({ error: "tab_not_active" });
    expect((await injectJson(h.app, "POST", "/api/agent/runs", { tabId: "tab_missing", task: "t", mode: "scripted" })).status).toBe(404);
    expect((await injectJson(h.app, "POST", "/api/agent/runs", { tabId, task: "t", mode: "yolo" })).status).toBe(400);
  });

  it("records a crashed agent as failed", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent });
    const { tabId } = await openTab(h);
    const run = (await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId, task: "explode", mode: "llm" })).body;
    await coreOf(h.ctx).agents.idle();
    expect((await injectJson<AgentRunDTO>(h.app, "GET", `/api/agent/runs/${run.id}`)).body).toMatchObject({ status: "failed", error: "agent crashed" });
  });

  it("passes the admin header to agents when demo mode is off", async () => {
    const agent = controllableAgent();
    h = await createHarness({ runAgent: agent.runAgent, config: { demo: false, adminToken: "adm1n" }, withSeller: false });
    const admin = { "x-p402-admin": "adm1n" };
    const company = (await injectJson<{ id: string }>(h.app, "POST", "/api/companies", { name: "Co" }, admin)).body;
    const tab = (await injectJson<{ tab: { id: string } }>(h.app, "POST", "/api/tabs", { companyId: company.id, policy: {} }, admin)).body.tab;
    h.settlement.approve(tab.id);
    const run = await injectJson<AgentRunDTO>(h.app, "POST", "/api/agent/runs", { tabId: tab.id, task: "t", mode: "scripted" }, admin);
    expect(run.status).toBe(201);
    expect(agent.runs[0]!.apiHeaders).toEqual(admin);
    agent.release(run.body.id);
  });
});
