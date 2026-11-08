/**
 * The JSON action the shopping agent emits each step (SPEC §8.2). Kept small and flat so Gemma 4 12B can
 * produce it reliably under a JSON-schema constraint; `llm.json` turns this zod schema into the schema.
 */
import { z } from "zod";
import type { ToolName } from "./tools";

export const AGENT_ACTIONS = ["search", "details", "price_history", "reviews", "propose_purchase", "finish"] as const;
export type AgentActionName = (typeof AGENT_ACTIONS)[number];

export const PAID_ACTIONS: ReadonlySet<AgentActionName> = new Set<AgentActionName>(["search", "details", "price_history", "reviews"]);

export function isPaidAction(action: AgentActionName): action is ToolName {
  return PAID_ACTIONS.has(action);
}

export const agentActionSchema = z.object({
  thought: z.string().describe("One or two short sentences: what you know and what you need next."),
  action: z.enum(AGENT_ACTIONS),
  args: z
    .object({
      query: z.string().optional().describe("search: what to look for"),
      max_price: z.number().optional().describe("search: price cap in dollars"),
      product_id: z.string().optional().describe("details, price_history, reviews, propose_purchase: an id from the search results"),
      reason: z.string().optional().describe("propose_purchase, finish: why, in one sentence"),
    })
    .describe("Arguments for the action"),
  value_of_information: z
    .string()
    .describe("Paid actions: one line on why this call is worth its price and how it could change your choice. Empty for propose_purchase and finish."),
});

export type AgentAction = z.infer<typeof agentActionSchema>;
