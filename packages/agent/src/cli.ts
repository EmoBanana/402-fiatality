/**
 * `npm run agent -- --tab <id> --token <enroll> --task "..." --mode llm|scripted|runaway [--gateway URL]`
 * Registers a fresh Ed25519 key on the tab with its enroll token, runs the shopping agent and prints every
 * step. Ctrl-C stops the run cleanly (twice quits at once).
 */
import { parseArgs } from "node:util";
import { createLlm } from "@p402/ai";
import { ConfigError, loadConfig, loadDotEnv } from "@p402/gateway/config";
import type { LlmClient } from "@p402/gateway/context";
import { formatUsd, newId, type AgentMode, type AgentStepDTO, type AgentStepKind } from "@p402/shared";
import { generateAgentKeyPair } from "@p402/shared/node";
import { GatewayApi } from "./gatewayApi";
import { runAgent } from "./run";
import { errorMessage } from "./util";

const USAGE = `Usage: npm run agent -- --tab <tabId> --token <enrollToken> --task "<what to buy>" [options]

Runs the 402 Fiatality shopping agent on a tab: it registers a fresh signing key with the tab's enroll token,
pays sellers per call with signed IOUs and prints every step.

Options:
  --tab <id>         Tab to spend from (required)
  --token <token>    The tab's enroll token, shown when the tab was opened (required)
  --task <text>      What to research and buy, e.g. "quiet espresso machine under $500" (required)
  --mode <mode>      llm (Gemma), scripted (no model) or runaway (loops until the gateway stops it). Default: llm
  --gateway <url>    Gateway origin. Default: http://localhost:<PORT from .env, 4020>
  --max-steps <n>    Cap on actions (llm) or paid calls (scripted, runaway)
  --task-id <id>     Cost-attribution id written into every voucher. Default: the run id
  --json             Print each step as one JSON line
  -h, --help         Show this help

Example:
  npm run agent -- --tab tab_abc --token et_xyz --task "quiet espresso machine under $500" --mode scripted`;

const MODES: readonly AgentMode[] = ["llm", "scripted", "runaway"];

async function main(): Promise<number> {
  let values: ReturnType<typeof parse>["values"];
  try {
    values = parse().values;
  } catch (err) {
    console.error(`${errorMessage(err)}\n\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const { tab, token, task } = values;
  if (!tab || !token || !task) {
    const missing = (["tab", "token", "task"] as const).filter((k) => !values[k]);
    console.error(`Missing ${missing.map((k) => `--${k}`).join(", ")}.\n\n${USAGE}`);
    return 2;
  }
  const mode = (values.mode ?? "llm") as AgentMode;
  if (!MODES.includes(mode)) {
    console.error(`--mode must be one of ${MODES.join(", ")}.`);
    return 2;
  }
  const maxSteps = values["max-steps"] === undefined ? undefined : Number(values["max-steps"]);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    console.error("--max-steps must be a positive integer.");
    return 2;
  }

  let config: ReturnType<typeof loadConfig>;
  try {
    loadDotEnv();
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof ConfigError ? err.message : errorMessage(err));
    return 1;
  }
  const gatewayUrl = (values.gateway ?? `http://localhost:${config.port}`).replace(/\/+$/, "");
  const apiHeaders = config.adminToken ? { "x-p402-admin": config.adminToken } : undefined;

  const keys = generateAgentKeyPair();
  const agentId = newId("agent");
  try {
    await new GatewayApi({ gatewayUrl, headers: apiHeaders }).registerAgentKey(tab, { agentId, publicKey: keys.publicKey, enrollToken: token });
  } catch (err) {
    console.error(`Could not register the agent key on tab ${tab}: ${errorMessage(err)}`);
    return 1;
  }

  let llm: LlmClient | undefined;
  if (mode === "llm") {
    try {
      llm = createLlm(config.llm);
    } catch (err) {
      console.error(`Could not create the LLM client: ${errorMessage(err)}. Try --mode scripted.`);
      return 1;
    }
    const health = await llm.health().catch((err: unknown) => ({ reachable: false, model: config.llm.model, detail: errorMessage(err) }));
    if (!health.reachable) {
      console.warn(
        paint(33, `warning: ${config.llm.provider} model ${health.model} is not reachable (${health.detail ?? "no detail"}); the agent switches to its built-in planner if the model keeps failing.`),
      );
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error(paint(33, "\nStopping after the current call (Ctrl-C again to quit now)..."));
    controller.abort();
  });

  const model = llm ? ` · ${llm.provider === "mock" ? "built-in planner" : `${llm.provider} ${llm.model}`}` : "";
  console.log(paint(1, `402 Fiatality agent ${agentId}`) + paint(2, ` · tab ${tab} · ${mode}${model} · ${gatewayUrl}`));
  console.log(paint(2, `Task: ${task}`));

  const result = await runAgent({
    runId: newId("run"),
    gatewayUrl,
    tabId: tab,
    agentId,
    privateKey: keys.privateKey,
    task,
    mode,
    llm,
    maxSteps,
    taskId: values["task-id"],
    apiHeaders,
    signal: controller.signal,
    onStep: values.json ? (step) => console.log(JSON.stringify(step)) : printStep,
  });

  if (!values.json) {
    const tone = result.status === "finished" ? 32 : result.status === "stopped" ? 33 : 31;
    console.log(`\n${paint(tone, result.status.toUpperCase())} ${paint(2, `spent ${formatUsd(result.spentMicros)}${result.purchaseId ? ` · purchase ${result.purchaseId}` : ""}`)}`);
  }
  return result.status === "failed" ? 1 : 0;
}

function parse() {
  return parseArgs({
    options: {
      tab: { type: "string" },
      token: { type: "string" },
      task: { type: "string" },
      mode: { type: "string" },
      gateway: { type: "string" },
      "max-steps": { type: "string" },
      "task-id": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
}

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;

function paint(code: number, text: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const LABELS: Record<AgentStepKind, [string, number]> = {
  thought: ["think", 2],
  paid_call: ["paid", 32],
  decision: ["decide", 36],
  purchase_proposal: ["propose", 35],
  paused: ["paused", 33],
  error: ["error", 31],
  finished: ["done", 1],
};

function printStep(step: AgentStepDTO): void {
  const voided = step.kind === "paid_call" && step.status === "voided";
  const [label, tone] = voided ? ["void", 31] : LABELS[step.kind];
  const head = `${paint(2, `#${String(step.index).padStart(2, "0")}`)} ${paint(tone, label.padEnd(7))}`;
  if (step.kind !== "paid_call") {
    console.log(`${head} ${step.text}`);
    return;
  }
  const cost = voided ? "free" : formatUsd(step.costMicros ?? 0);
  const where = `${step.sellerId ?? "?"} ${step.endpoint ?? ""}`.trim();
  console.log(`${head} ${paint(2, where)}  ${cost} ${paint(2, `· total ${formatUsd(step.cumulativeMicros ?? 0)}`)}`);
  console.log(`${" ".repeat(12)}${step.text}`);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(errorMessage(err));
    process.exit(1);
  },
);
