import type { AgentRunOptions, LlmClient, LlmMessage, RunningSellers } from "@p402/gateway/context";
import { demoSellers, startSellers } from "@p402/sellers";
import type { AgentStepDTO } from "@p402/shared";
import { generateAgentKeyPair } from "@p402/shared/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentAction } from "../src/actions";
import { createRunAgent } from "../src/run";
import { FakePaywall, fakeSellersFrom } from "./fakePaywall";

const keys = generateAgentKeyPair();
const AGENT = "agent_run";
const TASK = "Find a quiet espresso machine under $500 for a small office";
const runAgent = createRunAgent({ pacingMs: { scripted: 0, runaway: 0, llm: 0 }, sleep: async () => {} });

let sellers: RunningSellers;
let fake: FakePaywall;
let tabCounter = 0;

beforeAll(async () => {
  sellers = await startSellers({ port: 4440, host: "127.0.0.1", flakyRate: 0.5, seed: 8 });
  fake = await FakePaywall.start(4441, { tabId: "unused", sellers: [] });
});

afterAll(async () => {
  await fake.close();
  await sellers.close();
});

function newTab(extra: Partial<Parameters<FakePaywall["reset"]>[0]> = {}): string {
  const tabId = `tab_run_${++tabCounter}`;
  const listings = demoSellers({ sellersBaseUrl: sellers.url, channel3ApiKey: null, sellerEmails: { channel3: null, pricewatch: null, reviews: null } });
  fake.reset({ tabId, sellers: fakeSellersFrom(listings), ...extra });
  fake.keys.set(AGENT, keys.publicKey);
  return tabId;
}

function options(tabId: string, steps: AgentStepDTO[], extra: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    runId: `run_${tabId}`,
    gatewayUrl: fake.url,
    tabId,
    agentId: AGENT,
    privateKey: keys.privateKey,
    task: TASK,
    mode: "scripted",
    onStep: (step) => steps.push(step),
    ...extra,
  };
}

function paidCalls(steps: AgentStepDTO[]) {
  return steps.filter((s) => s.kind === "paid_call");
}

/** A model that replays canned replies and records what it was asked. */
function fakeLlm(replies: Array<AgentAction | Error>, provider: LlmClient["provider"] = "ollama") {
  const prompts: LlmMessage[][] = [];
  const llm: LlmClient = {
    provider,
    model: "gemma4:12b",
    chat: async () => "",
    json: async (messages, schema) => {
      prompts.push(messages);
      const next = replies.shift();
      if (!next) throw new Error("no more replies");
      if (next instanceof Error) throw next;
      return schema.parse(next);
    },
    health: async () => ({ reachable: true, model: "gemma4:12b" }),
  };
  return { llm, prompts };
}

function expectWellFormed(steps: AgentStepDTO[], runId: string) {
  expect(steps.map((s) => s.index)).toEqual(steps.map((_, i) => i));
  expect(steps.every((s) => s.runId === runId && s.text.length > 0 && typeof s.at === "number")).toBe(true);
  expect(steps.at(-1)?.kind).toBe("finished");
  expect(steps.filter((s) => s.kind === "finished")).toHaveLength(1);
}

describe("runAgent: scripted", () => {
  it("researches the top 3, survives voids and proposes a purchase", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const result = await runAgent(options(tabId, steps));

    expect(result.status).toBe("finished");
    expect(result.purchaseId).toBe("pur_1");
    expect(result.summary).toMatch(/^research \$0\.\d+ → purchase \$\d+\.\d{2}: .+ \(\d+ paid calls, \d+ voided and not billed\)\.$/);
    expectWellFormed(steps, `run_${tabId}`);

    const calls = paidCalls(steps);
    const byEndpoint = (prefix: string) => calls.filter((s) => s.endpoint?.startsWith(prefix)).length;
    expect(byEndpoint("POST /v1/search")).toBe(1);
    expect(byEndpoint("GET /v1/products/")).toBe(3);
    expect(byEndpoint("GET /v1/history/")).toBe(3);
    expect(byEndpoint("GET /v1/reviews/")).toBeGreaterThanOrEqual(3);
    const voided = calls.filter((s) => s.status === "voided");
    expect(voided.length).toBeGreaterThan(0);
    expect(voided.every((s) => s.costMicros === 0 && s.voidReason && s.sellerId === "reviews")).toBe(true);
    expect(steps.map((s) => s.kind)).toEqual(expect.arrayContaining(["thought", "paid_call", "decision", "purchase_proposal", "finished"]));

    // The agent's books match the paywall's ledger.
    const billable = fake.billableMicros();
    expect(result.spentMicros).toBe(billable);
    expect(calls.at(-1)?.cumulativeMicros).toBe(billable);
    expect(fake.purchases).toHaveLength(1);
    expect(fake.purchases[0]).toMatchObject({ tabId, researchCostMicros: billable });
    expect(fake.purchases[0]?.amountCents).toBeLessThanOrEqual(50_000);
    for (const seller of ["channel3", "pricewatch", "reviews"]) {
      const seqs = fake.vouchers.filter((v) => v.sellerId === seller).map((v) => v.seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    }
    expect(fake.vouchers.every((v) => v.task === `run_${tabId}` && v.agent === AGENT)).toBe(true);
  });

  it("retries the proposal without a data: image when the gateway rejects it", async () => {
    const tabId = newTab({ rejectDataImages: true });
    const steps: AgentStepDTO[] = [];
    const result = await runAgent(options(tabId, steps));
    expect(result.status).toBe("finished");
    expect(fake.purchases[0]?.imageUrl).toBeUndefined();
  });

  it("stops cleanly when aborted", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const controller = new AbortController();
    const result = await runAgent(
      options(tabId, steps, {
        signal: controller.signal,
        onStep: (step) => {
          steps.push(step);
          if (paidCalls(steps).length === 2) controller.abort();
        },
      }),
    );
    expect(result.status).toBe("stopped");
    expect(result.summary).toMatch(/^Stopped on request after 2 paid calls/);
    expect(paidCalls(steps)).toHaveLength(2);
    expectWellFormed(steps, `run_${tabId}`);
  });

  it("fails fast on a tab that is not approved yet", async () => {
    const tabId = newTab();
    fake.status = "pending_approval";
    const steps: AgentStepDTO[] = [];
    const result = await runAgent(options(tabId, steps));
    expect(result).toMatchObject({ status: "failed", spentMicros: 0, error: "tab_pending_approval" });
    expect(paidCalls(steps)).toHaveLength(0);
  });
});

describe("runAgent: runaway", () => {
  it("loops until the gateway pauses, reviews and freezes the tab", async () => {
    const tabId = newTab({ repeatThreshold: 5, freezeAfterPolls: 1, retryAfterSec: 0 });
    const steps: AgentStepDTO[] = [];
    const result = await runAgent(options(tabId, steps, { mode: "runaway", maxSteps: 30 }));

    expect(result.status).toBe("stopped");
    expect(result.summary).toContain("Runaway loop stopped by the gateway after 5 paid calls");
    expect(result.summary).toContain("the tab was frozen. AI review");
    expect(result.summary).toMatch(/AI review: freeze \(agent fault\): The agent repeated one search without using the results\.$/);
    expect(steps.find((s) => s.kind === "paused")?.text).toBe("Tab paused: repeat_request alarm, AI review running. Waiting for the review (retrying every 1 s).");
    expect(paidCalls(steps)).toHaveLength(5);
    expect(steps.filter((s) => s.kind === "paused")).toHaveLength(1);
    expect(fake.vouchers).toHaveLength(5);
    expect(new Set(fake.vouchers.map((v) => v.reqHash)).size).toBe(1);
    expect(result.spentMicros).toBe(25_000);
    expectWellFormed(steps, `run_${tabId}`);
  });

  it("is bounded when no alarm fires", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const result = await runAgent(options(tabId, steps, { mode: "runaway", maxSteps: 4 }));
    expect(result.status).toBe("finished");
    expect(result.summary).toContain("4 identical searches and no alarm stopped them");
    expect(paidCalls(steps)).toHaveLength(4);
  });
});

describe("runAgent: llm", () => {
  it("pays only for checked actions with a value-of-information reason", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const { llm, prompts } = fakeLlm([
      { thought: "Search first.", action: "search", args: { query: "quiet espresso machine" }, value_of_information: "" },
      { thought: "Search first.", action: "search", args: { query: "quiet espresso machine", max_price: 900 }, value_of_information: "No candidates yet; a search is the cheapest start." },
      { thought: "Check reviews.", action: "reviews", args: { product_id: "esp-9999" }, value_of_information: "Rating decides." },
      { thought: "Look closer at the quiet one.", action: "details", args: { product_id: "ESP-1005 (Steamwell)" }, value_of_information: "Confirms the offer of a $329 candidate." },
      { thought: "Same again.", action: "details", args: { product_id: "esp-1005" }, value_of_information: "Again." },
      { thought: "Quiet, in stock, within budget.", action: "propose_purchase", args: { product_id: "esp-1005", reason: "Quietest option under $500." }, value_of_information: "" },
    ]);
    const result = await runAgent(options(tabId, steps, { mode: "llm", llm }));

    expect(result.status).toBe("finished");
    expect(result.summary).toMatch(/^research \$0\.007 → purchase \$329\.00: Steamwell Quiet Brew Espresso Machine from homebarista\.example/);
    const calls = paidCalls(steps);
    expect(calls.map((s) => s.endpoint)).toEqual(["POST /v1/search", "GET /v1/products/esp-1005"]);
    const rejected = steps.filter((s) => s.kind === "thought" && s.text.startsWith("Rejected the model's"));
    expect(rejected.map((s) => s.text)).toEqual([
      expect.stringContaining("needs value_of_information"),
      expect.stringContaining('"esp-9999" is unknown'),
      expect.stringContaining("You already have details for esp-1005"),
    ]);
    expect(steps.find((s) => s.kind === "thought" && s.text.includes("Worth $0.005?"))?.text).toContain("a search is the cheapest start");
    expect(steps.find((s) => s.kind === "decision")?.text).toContain("Quietest option under $500.");
    expect(fake.purchases[0]).toMatchObject({ title: "Steamwell Quiet Brew Espresso Machine", amountCents: 32_900, merchant: "homebarista.example", researchCostMicros: 7_000 });

    // The search was capped at the task's $500 limit, not the model's $900.
    expect(steps.find((s) => s.endpoint === "POST /v1/search")?.text).toContain("under $500.00");
    const system = prompts[0]?.[0]?.content ?? "";
    expect(system).toContain("search {\"query\": text, \"max_price\": dollars (optional)}: $0.005 per call");
    expect(system).toContain("price_history {\"product_id\": id}: $0.01 per call");
    expect(system).toContain("value_of_information");
    const user = prompts.at(-1)?.[1]?.content ?? "";
    expect(user).toContain("Research budget $0.25: spent $0.007, left $0.243.");
    expect(user).toContain("esp-1005 | Steamwell Quiet Brew Espresso Machine | $329.00 at homebarista.example, in stock");
    expect(user).toContain("Your last reply was rejected: You already have details for esp-1005");
  });

  it("uses the built-in planner with the mock provider and still decides", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const { llm, prompts } = fakeLlm([], "mock");
    const result = await runAgent(options(tabId, steps, { mode: "llm", llm }));
    expect(prompts).toHaveLength(0);
    expect(result.status).toBe("finished");
    expect(result.purchaseId).toBe("pur_1");
    expect(result.summary).toMatch(/^research \$0\.\d+ → purchase \$\d+\.\d{2}: /);
    const thoughts = steps.filter((s) => s.kind === "thought" && /Worth \$0\.0\d+\?/.test(s.text));
    expect(thoughts.length).toBe(paidCalls(steps).length);
    // Price history only for the leader (and maybe the runner-up), not for every candidate.
    expect(paidCalls(steps).filter((s) => s.endpoint?.startsWith("GET /v1/history/")).length).toBeLessThanOrEqual(2);
  });

  it("falls back to the planner when the model keeps failing", async () => {
    const tabId = newTab();
    const steps: AgentStepDTO[] = [];
    const { llm } = fakeLlm([new Error("model returned invalid JSON twice"), new Error("connection refused")]);
    const result = await runAgent(options(tabId, steps, { mode: "llm", llm }));
    expect(result.status).toBe("finished");
    expect(steps.filter((s) => s.kind === "error")).toHaveLength(2);
    expect(steps.some((s) => s.text === "Switching to the built-in planner for the rest of the run.")).toBe(true);
    expect(fake.purchases).toHaveLength(1);
  });

  it("fails clearly without an LLM client", async () => {
    const tabId = newTab();
    const result = await runAgent(options(tabId, [], { mode: "llm" }));
    expect(result).toMatchObject({ status: "failed", error: "llm_missing" });
  });
});
