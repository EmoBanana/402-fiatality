import type { LlmConfig } from "@p402/gateway/context";
import { DEFAULT_POLICY, policySchema } from "@p402/shared";
import { afterEach, describe, expect, it } from "vitest";
import { demoCatalog } from "../src/fixtures";
import { createLlm } from "../src/llm";
import { draftToPolicy } from "../src/policy/draft";
import { parsePolicyWithLlm } from "../src/policy/parse";
import { parsePolicyText } from "../src/policy/regex";
import { summarizePolicy } from "../src/policy/summary";
import { downServerUrl, type FakeHandler, type FakeServer, ollamaReply, startFakeServer } from "./helpers/fake-llm-server";

const DEMO_TEXT =
  "Spend up to $40 this week on product research, no more than 2 cents per call, only Channel3 and PriceWatch, pause anything that loops";

const catalog = demoCatalog();
const rules = (text: string, cat = catalog) => draftToPolicy(parsePolicyText(text, cat));

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function fake(handler: FakeHandler): Promise<FakeServer> {
  const server = await startFakeServer(handler);
  servers.push(server);
  return server;
}
const ollama = (baseUrl: string) => createLlm({ provider: "ollama", baseUrl, model: "gemma4:12b", apiKey: null } satisfies LlmConfig);

describe("regex policy parser", () => {
  it("parses the demo sentence", () => {
    const p = rules(DEMO_TEXT);
    expect(p).toMatchObject({
      holdCents: 4_000,
      perCallMaxMicros: 20_000,
      allowedSellers: ["channel3", "pricewatch"],
      closeAfterDays: 7,
      closeAtCents: 4_000,
    });
    expect(p.alarms.repeatRequestThreshold).toBe(3);
    expect(policySchema.parse(p)).toEqual(p);
  });

  it.each([
    ["$5 per day", { dailyCapMicros: 5_000_000, holdCents: 3_500 }],
    ["$5/day and $50 total", { dailyCapMicros: 5_000_000, holdCents: 5_000 }],
    ["a daily cap of $2.50", { dailyCapMicros: 2_500_000 }],
    ["max 3 cents per call", { perCallMaxMicros: 30_000 }],
    ["each call under 1 cent", { perCallMaxMicros: 10_000 }],
    ["half a cent per request", { perCallMaxMicros: 5_000 }],
    ["$0.004 a call", { perCallMaxMicros: 4_000 }],
    ["Up to $50 this week. No call over 2 cents, $10 a day at most", { perCallMaxMicros: 20_000, holdCents: 5_000, dailyCapMicros: 10_000_000 }],
    ["no request above half a cent, $5 total", { perCallMaxMicros: 5_000, holdCents: 500 }],
    ["only reviews", { allowedSellers: ["reviews"] }],
    ["use anything but not reviews", { allowedSellers: ["channel3", "pricewatch"] }],
    ["30 calls a minute", { maxCallsPerMinute: 30 }],
    ["budget $25 for 3 days", { holdCents: 2_500, closeAfterDays: 3 }],
    ["$100 a month", { holdCents: 10_000, closeAfterDays: 28 }],
    ["close the tab at $10, hold $20", { closeAtCents: 1_000, holdCents: 2_000 }],
  ])("%s", (text, expected) => {
    expect(rules(text)).toMatchObject(expected);
  });

  it("reads alarm wishes", () => {
    expect(rules("stop after 3 errors in a row, warn me at 70%").alarms).toMatchObject({ errorStreak: 3, budgetWarnPct: 70 });
    expect(rules("pause if it makes 4 identical calls").alarms.repeatRequestThreshold).toBe(4);
    expect(rules("pause anything that loops").alarms.repeatRequestThreshold).toBe(3);
  });

  it("works without a catalog by slugging the named sellers", () => {
    expect(rules(DEMO_TEXT, []).allowedSellers).toEqual(["channel3", "pricewatch"]);
    expect(rules("only use Channel3, Price Watch or Reviews", []).allowedSellers).toEqual(["channel3", "price-watch", "reviews"]);
  });

  it("keeps defaults for text without limits and clamps absurd ones", () => {
    expect(rules("please be careful")).toEqual(DEFAULT_POLICY);
    expect(rules("spend up to $50,000,000").holdCents).toBe(1_000_000);
    expect(rules("hold 10 cents").holdCents).toBe(100);
  });

  it("summarizes in 3 to 6 plain-English bullets that match the numbers", () => {
    const summary = summarizePolicy(rules(DEMO_TEXT), catalog);
    expect(summary.length).toBeGreaterThanOrEqual(3);
    expect(summary.length).toBeLessThanOrEqual(6);
    expect(summary.join(" ")).toContain("$40.00");
    expect(summary.join(" ")).toContain("$0.02");
    expect(summary).toContain("Agents may only pay Channel3 and PriceWatch.");
    expect(summary.join(" ")).toMatch(/repeats 3 times within 60 s/);
  });
});

describe("parsePolicy with a model", () => {
  it("prompts with the catalog and converts the model's dollars", async () => {
    const server = await fake(() =>
      ollamaReply(
        JSON.stringify({
          holdDollars: 40,
          perCallMaxDollars: 0.02,
          dailyCapDollars: null,
          allowedSellers: ["Channel3", "PriceWatch"],
          maxCallsPerMinute: null,
          closeAfterDays: 7,
          pauseOnLoops: true,
        }),
      ),
    );
    const out = await parsePolicyWithLlm(ollama(server.url), DEMO_TEXT, catalog);

    expect(out.model).toBe("gemma4:12b");
    expect(out.usedFallback).toBe(false);
    expect(out.policy).toMatchObject({ holdCents: 4_000, perCallMaxMicros: 20_000, allowedSellers: ["channel3", "pricewatch"] });
    expect(out.policy.alarms.repeatRequestThreshold).toBe(3);

    const messages = server.requests[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("- channel3 (Channel3): POST /v1/search $0.005; GET /v1/products/:id $0.002");
    expect(messages[0]!.content).toContain("Defaults: hold $50.00");
    expect(messages.at(-1)!.content).toBe(DEMO_TEXT);
    expect(server.requests[0]!.body.format.required).toContain("perCallMaxDollars");
  });

  it("repairs a cents/dollars slip and fills gaps from the rules", async () => {
    const server = await fake(() =>
      ollamaReply(
        JSON.stringify({
          holdDollars: 40,
          perCallMaxDollars: 2,
          dailyCapDollars: null,
          allowedSellers: [],
          maxCallsPerMinute: null,
          closeAfterDays: null,
          pauseOnLoops: false,
        }),
      ),
    );
    const out = await parsePolicyWithLlm(ollama(server.url), DEMO_TEXT, catalog);
    expect(out.policy.perCallMaxMicros).toBe(20_000);
    expect(out.policy.allowedSellers).toEqual(["channel3", "pricewatch"]);
    expect(out.policy.alarms.repeatRequestThreshold).toBe(3);
  });

  it("falls back to the rules when the model returns junk twice", async () => {
    const server = await fake(() => ollamaReply("I think you want a $40 budget!"));
    const out = await parsePolicyWithLlm(ollama(server.url), DEMO_TEXT, catalog);
    expect(out).toMatchObject({ model: "regex", usedFallback: true, policy: { holdCents: 4_000, perCallMaxMicros: 20_000 } });
    expect(server.requests).toHaveLength(2);
  });

  it("falls back to the rules when Ollama is down", async () => {
    const out = await parsePolicyWithLlm(ollama(await downServerUrl()), "$5 per day, only reviews", catalog);
    expect(out).toMatchObject({ model: "regex", usedFallback: true, policy: { dailyCapMicros: 5_000_000, allowedSellers: ["reviews"] } });
    expect(out.summary.length).toBeGreaterThanOrEqual(3);
  });
});
