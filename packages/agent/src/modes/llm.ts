/**
 * LLM mode: Gemma picks one JSON action per step (SPEC §8.2). Every reply is checked before anything is paid:
 * a paid call needs a value-of-information line, a known product id, an unused (or voided) call and enough
 * budget; a rejected reply goes back to the model with the reason. When the provider is `mock`, or the model
 * keeps failing, the built-in planner takes the step instead, so the run always ends in a decision.
 */
import type { LlmClient } from "@p402/gateway/context";
import { formatCents, formatUsd } from "@p402/shared";
import { type AgentAction, agentActionSchema, isPaidAction } from "../actions";
import { planNextAction } from "../planner";
import { bestOffer } from "../products";
import { buildMessages } from "../prompt";
import { type ModeOutcome, type RunSession, RunStop, searchKey, type ToolArgs } from "../session";
import type { ToolName } from "../tools";
import { errorMessage, truncate } from "../util";

const REJECTIONS_BEFORE_PLANNER = 3;
const MODEL_FAILURES_BEFORE_PLANNER = 2;

type Checked = { ok: true; action: AgentAction; args: ToolArgs } | { ok: false; problem: string };

export async function runLlm(s: RunSession, llm: LlmClient | undefined, maxActions: number): Promise<ModeOutcome> {
  if (!llm) throw new RunStop({ status: "failed", summary: "Mode llm needs an LLM client.", error: "llm_missing" });
  let useModel = llm.provider !== "mock";
  s.thought(
    useModel
      ? `Researching with ${llm.model}: research budget ${formatUsd(s.budgetMicros)}, and every paid call needs a value-of-information reason.`
      : `LLM_PROVIDER=mock: the built-in planner stands in for the model (same tools, prices and value-of-information rule). Research budget ${formatUsd(s.budgetMicros)}.`,
  );

  let rejection: string | null = null;
  let rejectionsInARow = 0;
  let modelFailures = 0;
  let actions = 0;
  for (let turn = 0; actions < maxActions && turn < maxActions * 4; turn++) {
    s.checkAborted();
    if (!canAffordAnything(s)) {
      s.thought(`The research budget (${formatUsd(s.budgetLeftMicros)} left) can't cover another call; deciding with what I have.`);
      return s.decideAndPropose();
    }

    let checked: Checked | null = null;
    let source: "model" | "planner" = "planner";
    if (useModel) {
      let reply: AgentAction | null = null;
      try {
        reply = await llm.json(buildMessages(promptInput(s, maxActions - actions, rejection)), agentActionSchema, {
          temperature: 0.2,
          timeoutMs: 120_000,
          signal: s.signal,
        });
        modelFailures = 0;
      } catch (err) {
        if (s.signal?.aborted) throw err;
        modelFailures += 1;
        s.steps.emit("error", `The model did not return a usable action: ${truncate(errorMessage(err), 200)}`);
        if (modelFailures >= MODEL_FAILURES_BEFORE_PLANNER) {
          useModel = false;
          s.thought("Switching to the built-in planner for the rest of the run.");
        }
        continue;
      }
      checked = check(s, reply);
      if (checked.ok) {
        source = "model";
        rejection = null;
        rejectionsInARow = 0;
      } else {
        rejectionsInARow += 1;
        rejection = checked.problem;
        s.thought(`Rejected the model's ${reply.action.replace("_", " ")}: ${checked.problem}`, { rejected: reply });
        if (rejectionsInARow < REJECTIONS_BEFORE_PLANNER) continue;
        s.thought("Three rejected replies in a row: the built-in planner takes this step.");
        rejection = null;
        rejectionsInARow = 0;
        checked = null;
      }
    }
    if (!checked) {
      checked = check(s, planNextAction({ state: s.state, task: s.task, tools: available(s), budgetLeftMicros: s.budgetLeftMicros }));
      if (!checked.ok) break;
    }

    const { action, args } = checked;
    s.announce(action, source);
    actions += 1;
    if (action.action === "propose_purchase") return s.propose(args.productId ?? "", action.args.reason?.trim() || action.thought);
    if (action.action === "finish") return s.noPurchase(action.args.reason?.trim() || action.thought || "nothing fits the task");
    await s.perform(action.action as ToolName, args);
  }

  s.thought(actions >= maxActions ? `Reached the ${maxActions}-action limit; deciding with what I have.` : "Deciding with what I have.");
  return s.decideAndPropose();
}

/** Validate and normalize one action against what the agent knows and can afford. */
export function check(s: RunSession, action: AgentAction): Checked {
  const args = action.args ?? {};
  if (action.action === "finish") return { ok: true, action, args: {} };

  const productId = args.product_id ? resolveId(s, args.product_id) : null;
  if (action.action === "propose_purchase") {
    if (!productId) return { ok: false, problem: `propose_purchase needs a product_id from the search results${args.product_id ? ` ("${args.product_id}" is unknown)` : ""}.` };
    const product = s.state.products.get(productId);
    const offer = product ? bestOffer(product) : null;
    if (!offer) return { ok: false, problem: `${productId} has no offer with a price.` };
    if (!offer.inStock) return { ok: false, problem: `${productId} is out of stock.` };
    if (s.task.maxPriceCents !== null && offer.priceCents > s.task.maxPriceCents) {
      return { ok: false, problem: `${productId} costs ${formatCents(offer.priceCents)}, above the ${formatCents(s.task.maxPriceCents)} limit.` };
    }
    return { ok: true, action: { ...action, args: { ...args, product_id: productId } }, args: { productId } };
  }

  if (!isPaidAction(action.action)) return { ok: false, problem: `Unknown action ${String(action.action)}.` };
  const tool: ToolName = action.action;
  const spec = s.tools.specs.get(tool);
  if (!spec || s.state.blocked.has(tool)) return { ok: false, problem: `The ${tool} tool is not available; use another action.` };
  if (!action.value_of_information?.trim()) {
    return { ok: false, problem: `Every paid call needs value_of_information: one line on why ${tool} is worth ${formatUsd(spec.priceMicros)}.` };
  }
  if (spec.priceMicros > s.budgetLeftMicros) {
    return { ok: false, problem: `${tool} costs ${formatUsd(spec.priceMicros)} but only ${formatUsd(s.budgetLeftMicros)} of research budget is left. Decide now.` };
  }

  let toolArgs: ToolArgs;
  let key: string;
  if (tool === "search") {
    const query = args.query?.trim().slice(0, 200);
    if (!query) return { ok: false, problem: 'search needs args.query, e.g. {"query": "espresso machine"}.' };
    const asked = typeof args.max_price === "number" && args.max_price > 0 ? Math.round(args.max_price * 100) : null;
    const limit = s.task.maxPriceCents;
    const maxPriceCents = asked !== null && limit !== null ? Math.min(asked, limit) : (asked ?? limit);
    toolArgs = { query, maxPriceCents };
    key = searchKey(query, maxPriceCents);
  } else {
    if (!productId) {
      return { ok: false, problem: `${tool} needs a product_id from the search results${args.product_id ? ` ("${args.product_id}" is unknown)` : ""}.` };
    }
    toolArgs = { productId };
    key = productId;
  }
  if (s.state.has(tool, key)) return { ok: false, problem: `You already have ${tool} for ${tool === "search" ? `"${toolArgs.query}"` : key}; use it.` };
  if (s.state.attempts(tool, key) >= 2) return { ok: false, problem: `${tool} for ${key} already failed twice; move on.` };
  return { ok: true, action: { ...action, args: { ...args, ...(productId ? { product_id: productId } : {}) } }, args: toolArgs };
}

/** Accept the exact id, a different case, or an id buried in extra text ("esp-1001 (Brewline)"). */
function resolveId(s: RunSession, raw: string): string | null {
  const wanted = raw.trim();
  if (s.state.products.has(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  for (const id of s.state.products.keys()) if (id.toLowerCase() === lower) return id;
  const contained = [...s.state.products.keys()].filter((id) => lower.includes(id.toLowerCase()));
  return contained.length === 1 ? (contained[0] ?? null) : null;
}

function available(s: RunSession) {
  return new Map([...s.tools.specs].filter(([name]) => !s.state.blocked.has(name)));
}

function canAffordAnything(s: RunSession): boolean {
  return [...available(s).values()].some((spec) => spec.priceMicros <= s.budgetLeftMicros);
}

function promptInput(s: RunSession, actionsLeft: number, rejection: string | null) {
  return {
    task: s.opts.task,
    parsed: s.task,
    tools: [...available(s).values()],
    budgetMicros: s.budgetMicros,
    spentMicros: s.state.spentMicros,
    actionsLeft,
    state: s.state,
    leader: s.state.candidates(s.task.maxPriceCents)[0] ?? null,
    rejection,
  };
}

