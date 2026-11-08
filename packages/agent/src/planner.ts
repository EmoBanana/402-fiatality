/**
 * The built-in planner: a deterministic stand-in for the model when LLM_PROVIDER=mock or the model keeps
 * failing. It follows the rules the prompt gives Gemma: a value-of-information line before every paid call,
 * no repeated calls (a voided call may be retried once: it was free), and stop as soon as more data would not
 * change the choice.
 */
import { formatCents, formatUsd, type Micros } from "@p402/shared";
import type { AgentAction } from "./actions";
import { bestOffer } from "./products";
import { evidence, type ResearchState } from "./state";
import { broaden, type ParsedTask } from "./task";
import type { ToolName, ToolSpec } from "./tools";

export interface PlannerInput {
  state: ResearchState;
  task: ParsedTask;
  tools: Map<ToolName, ToolSpec>;
  budgetLeftMicros: Micros;
}

export function planNextAction({ state, task, tools, budgetLeftMicros }: PlannerInput): AgentAction {
  const usable = (tool: ToolName) => {
    const spec = tools.get(tool);
    return Boolean(spec && !state.blocked.has(tool) && spec.priceMicros <= budgetLeftMicros);
  };
  const price = (tool: ToolName) => formatUsd(tools.get(tool)?.priceMicros ?? 0);
  const name = (id: string) => state.products.get(id)?.title ?? id;
  const cost = (id: string) => {
    const product = state.products.get(id);
    const offer = product ? bestOffer(product) : null;
    return offer ? formatCents(offer.priceCents) : "this";
  };
  const limit = task.maxPriceCents;

  if (state.eligible(limit).length === 0) {
    const tried = state.calls.filter((c) => c.tool === "search").length;
    if (tried < 2 && usable("search")) {
      const args = { query: tried === 0 ? task.query : broaden(task.query), ...(limit ? { max_price: limit / 100 } : {}) };
      return tried === 0
        ? act("I have no candidates yet, so the first step is a search.", "search", args, `Without candidates there is nothing to decide; one ${price("search")} search is the cheapest start.`)
        : act(
            `The search for "${task.query}" found nothing I can buy; trying a broader query once.`,
            "search",
            args,
            `Candidates are still missing and a ${price("search")} search is the only way to get them.`,
          );
    }
    const limitText = limit ? ` under ${formatCents(limit)}` : "";
    if (state.ranking.length > 0) return finish(`Nothing in stock${limitText} matched the task.`);
    return finish(state.blocked.has("search") ? "The tab's policy refused the product search seller." : "The search found no matching products.");
  }

  // Details can reveal a shortlisted product is out of stock or over the limit: stop spending on it.
  const buyable = new Set(state.eligible(limit).map((e) => e.product.id));
  const shortlist = state.shortlist(limit, 3).filter((id) => buyable.has(id));

  for (const id of shortlist) {
    if (!state.has("details", id) && state.attempts("details", id) === 0 && usable("details")) {
      return act(
        `${name(id)} is on my shortlist; I want its offers and key features before comparing.`,
        "details",
        { product_id: id },
        `Confirms stock, merchant and features of a ${cost(id)} candidate; ${price("details")} is negligible next to that.`,
      );
    }
  }

  for (const id of shortlist) {
    const tries = state.attempts("reviews", id);
    if (!state.has("reviews", id) && tries < 2 && usable("reviews")) {
      return tries === 0
        ? act(
            `Ratings are what separate the shortlist, and ${name(id)} has none yet.`,
            "reviews",
            { product_id: id },
            `A weak rating would rule out this ${cost(id)} option; ${price("reviews")} is tiny next to the purchase.`,
          )
        : act(
            `The reviews call for ${name(id)} was voided, so I was not charged; trying once more.`,
            "reviews",
            { product_id: id },
            `Voided calls are free and the rating can still change the ranking; ${price("reviews")} only if it succeeds.`,
          );
    }
  }

  const ranked = state.candidates(limit, shortlist);
  const [leader, runnerUp] = ranked.length > 0 ? ranked : state.candidates(limit);
  if (!leader) return finish("Nothing on the shortlist can be bought.");

  const leaderId = leader.product.id;
  if (!state.has("price_history", leaderId) && state.attempts("price_history", leaderId) === 0 && usable("price_history")) {
    return act(
      `${leader.product.title} leads (${evidence(leader)}). Before committing: is ${formatCents(leader.offer.priceCents)} a good price today?`,
      "price_history",
      { product_id: leaderId },
      `If today's price is high, the runner-up or waiting could save far more than ${price("price_history")}; if it is low I can buy with confidence.`,
    );
  }
  if (leader.status === "high" && runnerUp) {
    const id = runnerUp.product.id;
    if (!state.has("price_history", id) && state.attempts("price_history", id) === 0 && usable("price_history")) {
      return act(
        `${leader.product.title} is priced high right now; the runner-up ${runnerUp.product.title} might be the better buy today.`,
        "price_history",
        { product_id: id },
        `A low price on the runner-up would flip my choice; ${price("price_history")} against a purchase of ${formatCents(runnerUp.offer.priceCents)}.`,
      );
    }
  }

  const where = leader.offer.domain ? ` from ${leader.offer.domain}` : "";
  return {
    thought: `More data would not change the choice: ${leader.product.title} at ${formatCents(leader.offer.priceCents)}${where} (${evidence(leader)}).`,
    action: "propose_purchase",
    args: { product_id: leaderId, reason: `Best value on the shortlist (${evidence(leader)}).` },
    value_of_information: "",
  };
}

function act(thought: string, action: ToolName, args: AgentAction["args"], voi: string): AgentAction {
  return { thought, action, args, value_of_information: voi };
}

function finish(reason: string): AgentAction {
  return { thought: reason, action: "finish", args: { reason }, value_of_information: "" };
}
