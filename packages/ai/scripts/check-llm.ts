/**
 * npm run check:llm: checks the configured model end to end (Phase 3 gate for gemma4:12b on Ollama).
 * Health, a JSON-schema smoke test, a policy parse, a canned three-role spend review, an AG Grid query and
 * the AG Studio chat proxy, with timings and a pass/fail table. Exits 1 when any step fails.
 * Reads .env through the gateway config; prints the provider, model and server origin only.
 */
import { readFileSync } from "node:fs";
import { loadConfig, loadDotEnv } from "@p402/gateway/config";
import type { LlmConfig } from "@p402/gateway/context";
import { formatCents, formatUsd } from "@p402/shared";
import { z } from "zod";
import { createAiService, createLlm, REVIEW_BUDGET_MS } from "../src";
import { cannedReview, demoCatalog } from "../src/fixtures";
import { truncate } from "../src/util/text";

const POLICY_TEXT =
  "Spend up to $40 this week on product research, no more than 2 cents per call, only Channel3 and PriceWatch, pause anything that loops";

interface Row {
  step: string;
  ok: boolean;
  ms: number;
  detail: string;
}

const tty = process.stdout.isTTY;
const paint = (code: number, text: string) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t: string) => paint(32, t);
const red = (t: string) => paint(31, t);
const dim = (t: string) => paint(2, t);
const bold = (t: string) => paint(1, t);

const rows: Row[] = [];

async function step(name: string, run: () => Promise<string>): Promise<boolean> {
  process.stdout.write(`${dim("…")} ${name}\n`);
  const started = performance.now();
  try {
    const detail = await run();
    rows.push({ step: name, ok: true, ms: performance.now() - started, detail });
    return true;
  } catch (err) {
    rows.push({ step: name, ok: false, ms: performance.now() - started, detail: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function printTable(): void {
  const width = Math.max(...rows.map((r) => r.step.length), 4);
  console.log(`\n${bold(`  ${"step".padEnd(width)}  result  ${"time".padStart(8)}  detail`)}`);
  for (const r of rows) {
    const result = r.ok ? green("PASS  ") : red("FAIL  ");
    console.log(`  ${r.step.padEnd(width)}  ${result}  ${seconds(r.ms).padStart(8)}  ${truncate(r.detail.replace(/\s+/g, " "), 110)}`);
  }
}

function printHelp(llm: LlmConfig, detail: string): void {
  console.log(`\n${bold("How to fix")}`);
  if (llm.provider === "ollama") {
    if (/not pulled/i.test(detail)) {
      console.log(`  The model is missing. Run:\n    ollama pull ${llm.model}`);
    } else if (/not reachable|ECONNREFUSED/i.test(detail)) {
      console.log("  Ollama is not running. Open the Ollama app, or run:\n    ollama serve");
      console.log(`  Then make sure the model is there:\n    ollama pull ${llm.model}`);
      console.log(`  Ollama on another host? Set LLM_BASE_URL in .env (now ${origin(llm.baseUrl)}).`);
    } else {
      console.log(`  ${detail}`);
    }
  } else {
    console.log("  Check LLM_BASE_URL, LLM_MODEL and LLM_API_KEY in .env.");
  }
  console.log("  Offline demo without a model: LLM_PROVIDER=mock.");
}

function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(invalid LLM_BASE_URL)";
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  let llmConfig: LlmConfig;
  try {
    llmConfig = loadConfig().llm;
  } catch (err) {
    console.error(red(`✗ ${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }

  const llm = createLlm(llmConfig);
  const ai = createAiService(llmConfig, { llm });

  console.log(bold("PayPal 402 · LLM check"));
  if (llmConfig.provider === "mock") {
    console.log("  provider mock (offline, deterministic rules)");
    console.log(dim(`  Set LLM_PROVIDER=ollama in .env to check ${llmConfig.model} on Ollama.`));
  } else {
    console.log(`  provider ${llmConfig.provider} · model ${llmConfig.model} · ${origin(llmConfig.baseUrl)}`);
  }
  console.log();

  let healthDetail = "";
  const healthy = await step("health", async () => {
    const health = await llm.health();
    healthDetail = health.detail ?? "";
    if (!health.reachable) throw new Error(health.detail ?? "not reachable");
    return llmConfig.provider === "ollama" ? `${health.model} is pulled and Ollama answers` : (health.detail ?? `${health.model} reachable`);
  });
  if (!healthy) {
    printTable();
    printHelp(llmConfig, healthDetail);
    process.exit(1);
  }

  await step("json schema (loads the model)", async () => {
    const schema = z.object({ sum: z.number().int(), sky: z.enum(["red", "green", "blue"]), words: z.array(z.string()).max(3) });
    const out = await llm.json(
      [
        { role: "system", content: "Answer with JSON only." },
        { role: "user", content: 'What is 17 + 25 (as "sum")? What colour is a clear daytime sky (as "sky")? Give up to three words about coffee (as "words").' },
      ],
      schema,
      { timeoutMs: 180_000, maxTokens: 120 },
    );
    if (llm.provider === "mock") return `schema-valid mock reply ${JSON.stringify(out)}`;
    if (out.sum !== 42) throw new Error(`expected sum 42, got ${out.sum}`);
    if (out.sky !== "blue") throw new Error(`expected sky "blue", got "${out.sky}"`);
    return JSON.stringify(out);
  });

  await step("policy parse", async () => {
    const out = await ai.parsePolicy(POLICY_TEXT, demoCatalog());
    const p = out.policy;
    const summary = `${formatCents(p.holdCents)} hold, ${formatUsd(p.perCallMaxMicros)} per call, sellers ${p.allowedSellers.join(", ")} (model ${out.model})`;
    if (out.usedFallback) throw new Error(`the model's answer was unusable, the regex fallback answered: ${summary}`);
    const problems = [
      p.holdCents !== 4_000 && `hold ${formatCents(p.holdCents)} instead of $40.00`,
      p.perCallMaxMicros !== 20_000 && `per call ${formatUsd(p.perCallMaxMicros)} instead of $0.02`,
      p.allowedSellers.join(",") !== "channel3,pricewatch" && `sellers ${p.allowedSellers.join(", ")} instead of channel3, pricewatch`,
    ].filter(Boolean);
    if (problems.length > 0) throw new Error(problems.join("; "));
    return summary;
  });

  await step("spend review (runaway loop)", async () => {
    const started = performance.now();
    const times: string[] = [];
    const result = await ai.reviewSpend(cannedReview("runaway"), (m) => {
      const at = seconds(performance.now() - started);
      times.push(`${m.role} ${at}`);
      console.log(`    ${bold(m.role.padEnd(10))} ${dim(at.padStart(7))}  ${m.content}`);
    });
    const verdict = `${result.verdict} (${result.fault} fault, confidence ${result.confidence}): ${result.reason}`;
    if (result.verdict !== "freeze") throw new Error(`expected freeze, got ${verdict}`);
    return `${verdict} [${times.join(", ")}; budget ${REVIEW_BUDGET_MS / 1000} s]`;
  });

  await step("grid query (AG Grid AI Toolkit)", async () => {
    const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/voucher-grid.json", import.meta.url), "utf8")) as {
      schema: Record<string, unknown>;
      state: Record<string, unknown>;
    };
    const out = await ai.gridQuery({ question: "show voided calls grouped by seller", schema: fixture.schema, state: fixture.state });
    if (out.model === "rules") throw new Error(`the model's answer was unusable, the rules answered: ${out.explanation}`);
    const filter = JSON.stringify((out.state.filter as { filterModel?: unknown } | undefined)?.filterModel ?? {});
    const groups = (out.state.rowGroup as { groupColIds?: string[] } | undefined)?.groupColIds ?? [];
    if (!/voided/i.test(filter) || !groups.includes("sellerId")) throw new Error(`unexpected grid state: filter ${filter}, groups [${groups.join(", ")}]`);
    return out.explanation;
  });

  await step("chat proxy (AG Studio)", async () => {
    const out = await ai.chatProxy({
      messages: [
        { role: "system", content: "You answer in one short sentence." },
        { role: "user", content: "Why would an AI agent pay per API call instead of a monthly plan?" },
      ],
      max_tokens: 80,
    });
    const text = out.choices[0]?.message.content ?? "";
    if (!text.trim()) throw new Error("empty answer");
    return text;
  });

  printTable();
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(red(`\n✗ ${failed.length} of ${rows.length} checks failed.`));
    process.exit(1);
  }
  console.log(green(`\n✓ All ${rows.length} checks passed on ${llm.provider === "mock" ? "the offline mock" : `${llm.provider} · ${llm.model}`}.`));
}

main().catch((err) => {
  console.error(red(`✗ ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
  process.exit(1);
});
