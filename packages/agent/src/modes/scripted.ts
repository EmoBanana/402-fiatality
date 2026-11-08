/**
 * Scripted mode: a fixed research sequence with no model, for demos and tests (SPEC §8.2).
 * search -> details for the top 3 -> 30-day price history -> reviews (the flaky seller voids some; a voided
 * call is retried once because it was free) -> decide -> propose_purchase.
 */
import { formatCents } from "@p402/shared";
import { bestOffer } from "../products";
import type { CallRecord } from "../state";
import type { ModeOutcome, RunSession, ToolArgs } from "../session";
import { broaden } from "../task";
import type { ToolName } from "../tools";

export async function runScripted(s: RunSession, maxCalls: number): Promise<ModeOutcome> {
  const { query, maxPriceCents } = s.task;
  const limit = maxPriceCents ? ` under ${formatCents(maxPriceCents)}` : "";
  s.thought(`Plan: search for "${query}"${limit}, compare the top 3 (details, 30-day price history, reviews), then propose the best value.`);

  let callsLeft = maxCalls;
  let cutShort = false;
  const call = async (tool: ToolName, args: ToolArgs): Promise<CallRecord | null> => {
    if (!s.tools.has(tool) || s.state.blocked.has(tool)) return null;
    if (callsLeft <= 0) {
      cutShort = true;
      return null;
    }
    callsLeft -= 1;
    return s.perform(tool, args);
  };

  await call("search", { query, maxPriceCents });
  if (s.state.eligible(maxPriceCents).length === 0) {
    const broader = broaden(query);
    if (broader !== query) {
      s.thought(`Nothing I can buy came back for "${query}"; trying "${broader}".`);
      await call("search", { query: broader, maxPriceCents });
    }
  }

  const shortlist = s.state.shortlist(maxPriceCents, 3);
  if (shortlist.length > 0) {
    const priced = shortlist.map((id) => {
      const product = s.state.products.get(id);
      const offer = product ? bestOffer(product) : null;
      return `${s.name(id)}${offer ? ` (${formatCents(offer.priceCents)})` : ""}`;
    });
    s.thought(`Shortlist: ${priced.join(", ")}. Checking each one's offer, price history and reviews.`);
  }
  for (const id of shortlist) await call("details", { productId: id });
  // Details can reveal a product is out of stock or over the limit: no more spending on it.
  const buyable = new Set(s.state.eligible(maxPriceCents).map((e) => e.product.id));
  const confirmed = shortlist.filter((id) => buyable.has(id));
  for (const id of confirmed) await call("price_history", { productId: id });
  for (const id of confirmed) {
    const first = await call("reviews", { productId: id });
    if (first?.status === "voided") {
      s.thought(`The reviews call for ${s.name(id)} was voided (${first.voidReason ?? "void rule"}), so it cost nothing; retrying once.`);
      await call("reviews", { productId: id });
    }
  }

  if (cutShort) s.thought(`Reached the ${maxCalls}-call limit; deciding with what I have.`);
  return s.decideAndPropose();
}
