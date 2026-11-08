/**
 * Prompts for the Gemma shopping agent. The system prompt lists each paid tool with its live price and the
 * rules (value of information before every paid call, stop when more data won't change the choice); the user
 * message is a compact research notebook rebuilt every step, so a 12B model never has to track history.
 */
import type { LlmMessage } from "@p402/gateway/context";
import { formatCents, formatUsd, type Micros } from "@p402/shared";
import { bestOffer } from "./products";
import { type Candidate, type CallRecord, evidence, type ResearchState } from "./state";
import type { ParsedTask } from "./task";
import type { ToolName, ToolSpec } from "./tools";

export interface PromptInput {
  task: string;
  parsed: ParsedTask;
  /** Tools the agent may still use. */
  tools: ToolSpec[];
  budgetMicros: Micros;
  spentMicros: Micros;
  actionsLeft: number;
  state: ResearchState;
  leader: Candidate | null;
  /** Why the previous reply was rejected. */
  rejection: string | null;
}

const TOOL_ARGS: Record<ToolName, string> = {
  search: '{"query": text, "max_price": dollars (optional)}',
  details: '{"product_id": id}',
  price_history: '{"product_id": id}',
  reviews: '{"product_id": id}',
};

export function buildMessages(input: PromptInput): LlmMessage[] {
  return [
    { role: "system", content: systemPrompt(input.tools) },
    { role: "user", content: statePrompt(input) },
  ];
}

export function systemPrompt(tools: ToolSpec[]): string {
  return [
    "You are a shopping research agent for a company. Every data call is paid from the company's PayPal tab, so buy information only when it can change your decision.",
    "",
    "Paid tools:",
    ...tools.map((t) => `- ${t.name} ${TOOL_ARGS[t.name]}: ${formatUsd(t.priceMicros)} per call. ${t.blurb[0]?.toUpperCase() ?? ""}${t.blurb.slice(1)}.`),
    "Free actions:",
    '- propose_purchase {"product_id": id, "reason": text}: ask a human to approve buying this product with PayPal. Ends the run.',
    '- finish {"reason": text}: stop without buying when nothing fits the task.',
    "",
    "Rules:",
    '1. Reply with one JSON object: {"thought": ..., "action": ..., "args": {...}, "value_of_information": ...}.',
    "2. Before every paid action, value_of_information says in one line why the answer is worth its price: what you expect to learn and how it could change your choice. Never pay for data that cannot change your choice.",
    "3. Use only product ids from the search results. Never repeat a call you already made, unless it was voided (voided calls cost nothing).",
    "4. Respect the price limit and the research budget.",
    "5. As soon as more data would not change your choice, call propose_purchase with the best product. Use finish only if nothing fits.",
    "",
    "Examples:",
    '{"thought":"No candidates yet.","action":"search","args":{"query":"wireless headphones","max_price":200},"value_of_information":"Without candidates there is no decision; one search is the cheapest start."}',
    '{"thought":"hp-2 is $30 cheaper than hp-1 but has no rating yet.","action":"reviews","args":{"product_id":"hp-2"},"value_of_information":"A weak rating would rule out the cheaper option; $0.003 is tiny next to a $149 purchase."}',
    '{"thought":"hp-2 is rated 4.5 and priced low today; more data would not change my choice.","action":"propose_purchase","args":{"product_id":"hp-2","reason":"Best rating under $200 and at a 30-day low."},"value_of_information":""}',
  ].join("\n");
}

export function statePrompt(input: PromptInput): string {
  const { state, parsed } = input;
  const left = Math.max(0, input.budgetMicros - input.spentMicros);
  const voided = state.voidedCalls ? ` (${state.voidedCalls} voided, not billed)` : "";
  const lines = [`Task: ${input.task}`];
  if (parsed.maxPriceCents) lines.push(`Price limit: ${formatCents(parsed.maxPriceCents)}`);
  lines.push(
    `Research budget ${formatUsd(input.budgetMicros)}: spent ${formatUsd(input.spentMicros)}, left ${formatUsd(left)}. Paid calls: ${state.paidCalls}${voided}. Actions left: ${input.actionsLeft}.`,
    "",
  );

  if (state.ranking.length === 0) lines.push("Products found: none yet.");
  else {
    lines.push("Products found (search order):");
    state.ranking.slice(0, 8).forEach((id, i) => lines.push(`${i + 1}. ${productLine(state, id)}`));
  }

  if (state.calls.length > 0) {
    lines.push("", "Calls so far:");
    for (const call of state.calls.slice(-12)) lines.push(`${call.n}. ${callLine(call)}`);
  }
  if (state.blocked.size > 0) lines.push("", `Refused by the tab's policy, do not use: ${[...state.blocked].join(", ")}.`);
  if (input.leader) lines.push("", `Rule-of-thumb leader so far: ${input.leader.product.id} (${evidence(input.leader)}).`);
  if (input.rejection) lines.push("", `Your last reply was rejected: ${input.rejection}`);
  lines.push("", "Reply with the next action as one JSON object.");
  return lines.join("\n");
}

function productLine(state: ResearchState, id: string): string {
  const product = state.products.get(id);
  if (!product) return id;
  const offer = bestOffer(product);
  const parts = [id, product.title];
  parts.push(offer ? `${formatCents(offer.priceCents)}${offer.domain ? ` at ${offer.domain}` : ""}, ${offer.inStock ? "in stock" : "OUT OF STOCK"}` : "no price");
  if (state.detailed.has(id) && product.features.length > 0) parts.push(`features: ${product.features.slice(0, 3).join("; ")}`);
  const history = state.history.get(id);
  parts.push(history ? `price today: ${history.status} (30-day mean ${formatCents(history.meanCents)})` : "price today: ?");
  const reviews = state.reviews.get(id);
  parts.push(
    reviews && reviews.rating !== null
      ? `reviews: ${reviews.rating.toFixed(1)}/5 (${reviews.count})${reviews.pros[0] ? `, + ${reviews.pros[0]}` : ""}${reviews.cons[0] ? `, - ${reviews.cons[0]}` : ""}`
      : "reviews: ?",
  );
  return parts.join(" | ");
}

function callLine(call: CallRecord): string {
  const target = call.tool === "search" ? `"${call.key.split("|")[0]}"` : call.key;
  const cost = call.status === "accepted" ? ` (${formatUsd(call.costMicros)})` : "";
  return `${call.tool} ${target} -> ${call.summary}${cost}`;
}
