import { readFileSync } from "node:fs";
import type { AiService } from "@p402/gateway/context";
import { testConfig } from "@p402/gateway/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAiService, createLlm, warmUp } from "../src";
import { cannedReview, demoCatalog } from "../src/fixtures";
import { downServerUrl, type FakeServer, lastMessage, ollamaReply, startFakeServer } from "./helpers/fake-llm-server";

const grid = JSON.parse(readFileSync(new URL("./fixtures/voucher-grid.json", import.meta.url), "utf8")) as {
  schema: Record<string, unknown>;
  state: Record<string, unknown>;
};

const servers: FakeServer[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("createAiService in offline mock mode", () => {
  it("runs every feature from the default test config without touching the network", async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("network used in mock mode")));
    vi.stubGlobal("fetch", fetchSpy);
    const ai: AiService = createAiService(testConfig().llm);

    expect(ai.llm.provider).toBe("mock");
    expect(await ai.llm.health()).toMatchObject({ reachable: true, model: "mock" });

    const policy = await ai.parsePolicy("Spend up to $40 this week, no more than 2 cents per call, only Channel3 and PriceWatch", demoCatalog());
    expect(policy).toMatchObject({ model: "mock", usedFallback: false });
    expect(policy.policy).toMatchObject({ holdCents: 4_000, perCallMaxMicros: 20_000, allowedSellers: ["channel3", "pricewatch"] });

    const roles: string[] = [];
    const review = await ai.reviewSpend(cannedReview("runaway"), (m) => roles.push(m.role));
    expect(review).toMatchObject({ verdict: "freeze", model: "mock" });
    expect(roles).toEqual(["prosecutor", "defender", "judge"]);

    const query = await ai.gridQuery({ question: "voided calls by seller", schema: grid.schema, state: grid.state });
    expect(query).toMatchObject({ model: "mock", state: { rowGroup: { groupColIds: ["sellerId"] } } });

    const chat = await ai.chatProxy({ messages: [{ role: "user", content: "hello" }] });
    expect(chat.choices[0]!.message.content).toMatch(/offline mock model/);

    expect(await warmUp(ai.llm)).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("passes the clock and debate pacing through", async () => {
    let t = 1_000;
    const ai = createAiService(testConfig().llm, { now: () => (t += 500), mockDelayMs: 1 });
    const review = await ai.reviewSpend(cannedReview("flaky"), () => {});
    expect(review.transcript.map((m) => m.at)).toEqual([1_500, 2_000, 2_500]);
  });
});

describe("createAiService with a model", () => {
  it("uses an injected client and the review budget option", async () => {
    const server = await startFakeServer((req) => {
      if (lastMessage(req).includes("You are the prosecutor")) return { ...ollamaReply("too slow"), delayMs: 2_000 };
      return ollamaReply(
        '{"holdDollars":12,"perCallMaxDollars":null,"dailyCapDollars":null,"allowedSellers":["*"],"maxCallsPerMinute":60,"closeAfterDays":null,"pauseOnLoops":false}',
      );
    });
    servers.push(server);
    const ai = createAiService(testConfig().llm, {
      llm: createLlm({ provider: "ollama", baseUrl: server.url, model: "gemma4:12b", apiKey: null }),
      reviewBudgetMs: 300,
    });

    const policy = await ai.parsePolicy("twelve bucks, 60 calls per minute", demoCatalog());
    expect(policy).toMatchObject({ model: "gemma4:12b", usedFallback: false });
    expect(policy.policy).toMatchObject({ holdCents: 1_200, maxCallsPerMinute: 60, allowedSellers: ["*"] });

    const review = await ai.reviewSpend(cannedReview("runaway"), () => {});
    expect(review.verdict).toBe("escalate");
    expect(review.reason).toMatch(/budget/);
  });

  it("warmUp reports a model it cannot reach instead of throwing", async () => {
    const llm = createLlm({ provider: "ollama", baseUrl: await downServerUrl(), model: "gemma4:12b", apiKey: null });
    expect(await warmUp(llm, 2_000)).toBe(false);
  });
});
