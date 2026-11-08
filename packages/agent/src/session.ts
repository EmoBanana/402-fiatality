/**
 * One agent run: the x402 client, the paid tools, what was learned, and the step feed. The three modes
 * (scripted, runaway, llm) only decide which action comes next; this class performs it, records the cost and
 * reports it as AgentStepDTOs.
 */
import type { AgentRunOptions, AgentRunResult } from "@p402/gateway/context";
import { formatCents, formatUsd, type AgentMode, type Micros, type PurchaseDTO, type PurchaseProposalDTO } from "@p402/shared";
import { type AgentAction, isPaidAction } from "./actions";
import { GatewayApi, GatewayApiError } from "./gatewayApi";
import { bestOffer, type OfferView, type ProductView } from "./products";
import { type Candidate, type CallRecord, evidence, ResearchState } from "./state";
import { StepEmitter } from "./steps";
import { type ParsedTask, parseTask } from "./task";
import { resolveTools, ShopTools, type ToolCall, type ToolName } from "./tools";
import { errorMessage, sleep, truncate } from "./util";
import { type ChannelBook, type PauseInfo, X402Client, X402Error } from "./x402Client";

/** Test and embedding hooks; the RunAgent signature itself stays exactly the contract's. */
export interface RunDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Pause between paid calls so live feeds can follow the run (ms per mode). */
  pacingMs?: Partial<Record<AgentMode, number>>;
  /** Longest a call waits on a paused tab (default 120 s). */
  maxPauseWaitMs?: number;
  /** Research budget for llm mode (default $0.25, capped by what is left on the hold). */
  researchBudgetMicros?: Micros;
  channels?: ChannelBook;
  /** Clock for step timestamps. */
  now?: () => number;
}

export interface ModeOutcome {
  status: AgentRunResult["status"];
  summary: string;
  purchaseId?: string | null;
  error?: string | null;
}

/** Ends a run early with a known outcome. */
export class RunStop extends Error {
  override name = "RunStop";
  constructor(readonly outcome: ModeOutcome) {
    super(outcome.summary);
  }
}

export const DEFAULT_RESEARCH_BUDGET_MICROS: Micros = 250_000;
const DEFAULT_PACING: Record<AgentMode, number> = { llm: 0, scripted: 400, runaway: 300 };
const MAX_CONSECUTIVE_FAILURES = 3;

const TAB_NOT_USABLE: Record<string, string> = {
  pending_approval: "is waiting for its PayPal hold to be approved",
  frozen: "is frozen",
  closing: "is closing",
  settled: "is already settled",
  cancelled: "was cancelled",
  failed: "failed to settle",
};

const STOP_REASONS: Record<string, string> = {
  tab_frozen: "the tab was frozen",
  paused_timeout: "the tab stayed paused (the review needs a human decision)",
  tab_paused: "the tab is paused",
  tab_not_active: "the tab is not active",
  tab_not_found: "the tab does not exist",
  hold_exhausted: "the PayPal hold is used up",
  daily_cap_reached: "the tab's daily spending cap was reached",
  rate_limited: "the tab's rate limit was hit",
  invalid_signature: "the gateway rejected this agent's signature (is its key registered on the tab?)",
};

export interface ToolArgs {
  query?: string;
  maxPriceCents?: number | null;
  productId?: string;
}

export class RunSession {
  readonly steps: StepEmitter;
  readonly api: GatewayApi;
  readonly client: X402Client;
  readonly state = new ResearchState();
  readonly task: ParsedTask;
  tools: ShopTools;
  budgetMicros: Micros;
  private callsMade = 0;
  private failuresInARow = 0;
  private pausedAt: number | null = null;

  constructor(
    readonly opts: AgentRunOptions,
    private readonly deps: RunDeps = {},
  ) {
    const gatewayUrl = opts.gatewayUrl.replace(/\/+$/, "");
    this.steps = new StepEmitter(opts.runId, opts.onStep, deps.now);
    this.api = new GatewayApi({ gatewayUrl, headers: opts.apiHeaders, fetch: deps.fetch, signal: opts.signal });
    this.client = new X402Client({
      gatewayUrl,
      tabId: opts.tabId,
      agentId: opts.agentId,
      privateKey: opts.privateKey,
      taskId: opts.taskId ?? opts.runId,
      signal: opts.signal,
      api: this.api,
      fetch: deps.fetch,
      sleep: deps.sleep,
      maxPauseWaitMs: deps.maxPauseWaitMs,
      channels: deps.channels,
      onPaused: (info) => this.onPaused(info),
    });
    this.task = parseTask(opts.task);
    this.tools = new ShopTools(this.client, resolveTools(null));
    this.budgetMicros = deps.researchBudgetMicros ?? DEFAULT_RESEARCH_BUDGET_MICROS;
  }

  get signal(): AbortSignal | undefined {
    return this.opts.signal;
  }

  get mode(): AgentMode {
    return this.opts.mode;
  }

  get budgetLeftMicros(): Micros {
    return Math.max(0, this.budgetMicros - this.state.spentMicros);
  }

  checkAborted(): void {
    this.opts.signal?.throwIfAborted();
  }

  /** Learn the tools and prices from the catalog and check the tab can pay. */
  async init(): Promise<void> {
    this.tools = new ShopTools(this.client, resolveTools(await this.client.catalog()));
    if (!this.tools.has("search")) {
      throw new RunStop({ status: "failed", summary: "No seller in the catalog offers product search (POST /v1/search).", error: "no_search_seller" });
    }
    let tab: Awaited<ReturnType<GatewayApi["tab"]>> | null = null;
    try {
      tab = await this.api.tab(this.opts.tabId);
    } catch (err) {
      if (this.signal?.aborted) throw err;
      if (err instanceof GatewayApiError && err.status === 404) {
        throw new RunStop({ status: "failed", summary: `Tab ${this.opts.tabId} was not found.`, error: "tab_not_found" });
      }
    }
    if (!tab) return;
    const why = TAB_NOT_USABLE[tab.status];
    if (why) throw new RunStop({ status: "failed", summary: `Tab ${tab.id} ${why}; no calls were made.`, error: `tab_${tab.status}` });
    this.budgetMicros = Math.min(this.budgetMicros, Math.max(0, tab.totals.remainingMicros));
  }

  thought(text: string, data?: unknown): void {
    this.steps.emit("thought", text, { data });
  }

  /** The agent's reasoning before an action, with the value-of-information line for paid calls. */
  announce(action: AgentAction, source: "model" | "planner" | "script"): void {
    const paid = isPaidAction(action.action);
    const price = paid ? this.tools.specs.get(action.action as ToolName)?.priceMicros : undefined;
    const voi = action.value_of_information.trim();
    const thought = action.thought.trim() || `Next: ${action.action.replace("_", " ")}.`;
    this.steps.emit("thought", paid && voi && price ? `${thought} Worth ${formatUsd(price)}? ${voi}` : thought, {
      data: { action: action.action, args: action.args, valueOfInformation: voi || undefined, priceMicros: price, source },
    });
  }

  /** Run one paid tool call, record it and emit its paid_call step (`label` replaces the default wording). */
  async perform(tool: ToolName, args: ToolArgs, label?: string): Promise<CallRecord> {
    this.checkAborted();
    if (this.callsMade > 0) await this.pace();
    this.callsMade += 1;
    const productId = args.productId ?? "";
    const query = args.query ?? this.task.query;
    const key = tool === "search" ? searchKey(query, args.maxPriceCents ?? null) : productId;
    try {
      switch (tool) {
        case "search": {
          const limit = args.maxPriceCents ?? null;
          const call = await this.tools.search({ query, maxPriceCents: limit });
          if (call.data) this.state.addSearchResults(call.data);
          const found = call.data ?? [];
          const top = found
            .slice(0, 3)
            .map((p) => `${p.title} ${priceText(p)}`)
            .join("; ");
          const what = label ?? `Searched "${query}"${limit ? ` under ${formatCents(limit)}` : ""}`;
          return this.settle(call, key, what, found.length ? `${found.length} products${top ? ` (${top})` : ""}` : "no products", {
            query,
            maxPriceCents: limit,
            products: found.slice(0, 6).map((p) => ({ id: p.id, title: p.title, priceCents: bestOffer(p)?.priceCents ?? null })),
          });
        }
        case "details": {
          const call = await this.tools.details(productId);
          if (call.data) this.state.addDetails(productId, call.data);
          const product = this.state.products.get(productId);
          const offer = product ? bestOffer(product) : null;
          return this.settle(
            call,
            key,
            label ?? `Details for ${this.name(productId)}`,
            offer ? `${formatCents(offer.priceCents)}${offer.domain ? ` at ${offer.domain}` : ""}, ${offer.inStock ? "in stock" : "out of stock"}` : "no usable offer",
            { productId },
          );
        }
        case "price_history": {
          const product = this.state.products.get(productId);
          const call = await this.tools.priceHistory(productId, product ? (bestOffer(product)?.priceCents ?? null) : null);
          if (call.data) this.state.history.set(productId, call.data);
          const h = call.data;
          return this.settle(
            call,
            key,
            label ?? `Price history for ${this.name(productId)}`,
            h ? `${formatCents(h.currentCents)} today vs a 30-day mean of ${formatCents(h.meanCents)} (${h.status})` : "",
            { productId, history: h },
          );
        }
        case "reviews": {
          const call = await this.tools.reviews(productId);
          if (call.data && call.data.count > 0) this.state.reviews.set(productId, call.data);
          const r = call.data;
          return this.settle(
            call,
            key,
            label ?? `Reviews for ${this.name(productId)}`,
            r ? (r.rating === null ? "no ratings" : `${r.rating.toFixed(1)}/5 from ${r.count.toLocaleString("en-US")} reviews`) : "",
            { productId, rating: r?.rating ?? null, count: r?.count ?? null },
          );
        }
      }
    } catch (err) {
      if (!(err instanceof X402Error) || err.scope === "tab" || this.signal?.aborted) throw err;
      return this.refused(tool, key, err);
    }
  }

  /** Pick the best candidate by the rule of thumb and propose it. */
  async decideAndPropose(): Promise<ModeOutcome> {
    const ranked = this.state.candidates(this.task.maxPriceCents);
    const best = ranked[0];
    if (!best) {
      const limit = this.task.maxPriceCents ? ` under ${formatCents(this.task.maxPriceCents)}` : "";
      if (this.state.ranking.length > 0) return this.noPurchase(`nothing in stock${limit}`);
      return this.noPurchase(this.state.blocked.has("search") ? "the tab's policy refused the product search seller" : "the search found no matching products");
    }
    const runnerUp = ranked[1];
    const why = `${evidence(best)}${runnerUp ? `. Runner-up: ${runnerUp.product.title} (${formatCents(runnerUp.offer.priceCents)}, ${evidence(runnerUp)})` : ""}.`;
    return this.propose(best.product.id, why, ranked);
  }

  /** Emit the decision, file the proposal with POST /api/purchases and summarize the run. */
  async propose(productId: string, reasoning: string, ranked?: Candidate[]): Promise<ModeOutcome> {
    const product = this.state.products.get(productId);
    const offer = product ? bestOffer(product) : null;
    if (!product || !offer) return this.noPurchase(`no usable offer for ${productId}`);
    const candidates = (ranked ?? this.state.candidates(this.task.maxPriceCents)).slice(0, 5).map((c) => ({
      id: c.product.id,
      title: c.product.title,
      priceCents: c.offer.priceCents,
      rating: c.rating,
      priceStatus: c.status,
      score: c.score,
    }));
    this.steps.emit("decision", `Chose ${product.title} at ${formatCents(offer.priceCents)}${offer.domain ? ` from ${offer.domain}` : ""}. ${reasoning}`, {
      data: { productId, candidates },
    });

    const proposal: PurchaseProposalDTO = {
      tabId: this.opts.tabId,
      title: product.title,
      amountCents: offer.priceCents,
      merchant: offer.domain ?? undefined,
      productUrl: offer.url ?? undefined,
      imageUrl: product.imageUrl ?? undefined,
      researchCostMicros: this.state.spentMicros,
      reasoning: truncate(reasoning, 500),
    };
    let purchase: PurchaseDTO;
    try {
      purchase = await this.fileProposal(proposal);
    } catch (err) {
      if (this.signal?.aborted) throw err;
      const message = errorMessage(err);
      this.steps.emit("error", `Could not file the purchase proposal: ${message}`);
      return {
        status: "failed",
        summary: `research ${formatUsd(this.state.spentMicros)} → purchase ${formatCents(offer.priceCents)} not filed: ${message}`,
        error: message,
      };
    }
    this.steps.emit(
      "purchase_proposal",
      `Proposed ${product.title} for ${formatCents(offer.priceCents)}${offer.domain ? ` from ${offer.domain}` : ""}; it needs approval with PayPal.`,
      {
        cumulativeMicros: this.state.spentMicros,
        data: {
          purchaseId: purchase.id,
          status: purchase.status,
          title: proposal.title,
          amountCents: proposal.amountCents,
          merchant: proposal.merchant,
          productUrl: proposal.productUrl,
          researchCostMicros: proposal.researchCostMicros,
        },
      },
    );
    return { status: "finished", summary: this.purchaseSummary(product, offer), purchaseId: purchase.id };
  }

  noPurchase(reason: string): ModeOutcome {
    return { status: "finished", summary: `research ${formatUsd(this.state.spentMicros)} → no purchase: ${reason} (${this.callStats()}).` };
  }

  /** Map anything thrown out of a mode to the run's outcome. */
  async outcomeFor(err: unknown): Promise<ModeOutcome> {
    if (this.signal?.aborted) {
      return { status: "stopped", summary: `Stopped on request after ${this.callStats()}; research ${formatUsd(this.state.spentMicros)}.` };
    }
    if (err instanceof RunStop) return err.outcome;
    if (err instanceof X402Error && err.scope === "tab") {
      const what = STOP_REASONS[err.reason] ?? `the gateway refused further calls (${err.reason})`;
      const review = await this.reviewFor(err.reason);
      const reviewText = review ? ` ${review}` : "";
      if (this.mode === "runaway") {
        this.thought(`The gateway stopped the loop: ${what}.${reviewText}`);
        return {
          status: "stopped",
          summary: `Runaway loop stopped by the gateway after ${this.callStats()} (${formatUsd(this.state.spentMicros)} billed): ${what}.${reviewText}`,
        };
      }
      this.steps.emit("error", `Stopping: ${what}. ${err.message}`);
      return {
        status: "stopped",
        summary: `Stopped: ${what}.${reviewText} Research so far ${formatUsd(this.state.spentMicros)} (${this.callStats()}).`,
      };
    }
    const message = errorMessage(err);
    this.steps.emit("error", `Run failed: ${message}`);
    return { status: "failed", summary: `Failed after ${this.callStats()}: ${message}`, error: message };
  }

  callStats(): string {
    const paid = this.state.paidCalls;
    const voided = this.state.voidedCalls;
    return `${paid} paid call${paid === 1 ? "" : "s"}${voided ? `, ${voided} voided and not billed` : ""}`;
  }

  name(productId: string): string {
    return this.state.products.get(productId)?.title ?? productId;
  }

  // ------------------------------------------------------------ internals

  private async pace(): Promise<void> {
    const ms = this.deps.pacingMs?.[this.mode] ?? DEFAULT_PACING[this.mode];
    if (ms > 0) await (this.deps.sleep ?? sleep)(ms, this.signal);
  }

  private settle<T>(call: ToolCall<T>, key: string, what: string, result: string, data: Record<string, unknown>): CallRecord {
    if (this.pausedAt !== null) {
      const waited = call.waitedMs || Date.now() - this.pausedAt;
      this.thought(`The tab is active again after ${Math.round(waited / 1000)} s; continuing.`);
      this.pausedAt = null;
    }
    this.failuresInARow = 0;
    const billed = call.status === "voided" ? "not billed" : call.status === "unpaid" ? "not paid" : formatUsd(call.costMicros);
    const outcome =
      call.status === "voided"
        ? `voided (${call.voidReason ?? "void rule"}), not billed`
        : call.data === null
          ? `${call.problem ?? "no data"} (${billed})`
          : result;
    const record = this.state.record({ tool: call.tool, key, status: call.status, costMicros: call.costMicros, voidReason: call.voidReason, summary: outcome });
    this.steps.emit("paid_call", `${what}: ${outcome}`, {
      costMicros: call.costMicros,
      cumulativeMicros: this.state.spentMicros,
      sellerId: call.sellerId,
      endpoint: call.endpoint,
      status: call.status === "unpaid" ? undefined : call.status,
      voidReason: call.voidReason ?? undefined,
      data: { tool: call.tool, priceMicros: call.priceMicros, seq: call.seq, channelCumulativeMicros: call.channelCumulativeMicros, httpStatus: call.httpStatus, ...data },
    });
    return record;
  }

  /** The gateway refused this one call (or this seller): record it, tell the feed, keep researching. */
  private refused(tool: ToolName, key: string, err: X402Error): CallRecord {
    this.failuresInARow += 1;
    this.pausedAt = null;
    const spec = this.tools.specs.get(tool);
    if (err.scope === "seller") {
      for (const s of this.tools.specs.values()) if (s.sellerId === (err.sellerId ?? spec?.sellerId)) this.state.blocked.add(s.name);
    }
    const record = this.state.record({ tool, key, status: "failed", costMicros: 0, voidReason: null, summary: `refused by the gateway (${err.reason})` });
    this.steps.emit("error", `${tool.replace("_", " ")} call refused (${err.reason}): ${err.message}`, {
      sellerId: err.sellerId ?? spec?.sellerId,
      data: { tool, reason: err.reason },
    });
    if (this.failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
      throw new RunStop({
        status: "failed",
        summary: `Gave up after ${this.failuresInARow} refused calls in a row (last: ${err.reason}). Research so far ${formatUsd(this.state.spentMicros)}.`,
        error: err.message,
      });
    }
    return record;
  }

  private onPaused(info: PauseInfo): void {
    if (this.pausedAt !== null) return;
    this.pausedAt = Date.now();
    const message = info.message.replace(/[.!\s]+$/, "");
    const what = /paused/i.test(message) ? message : `Tab paused by the gateway: ${message}`;
    this.steps.emit("paused", `${what}. Waiting for the review (retrying every ${Math.round(info.waitMs / 1000) || 1} s).`, {
      sellerId: info.sellerId,
      endpoint: info.endpoint,
      data: { waitMs: info.waitMs },
    });
  }

  private async fileProposal(proposal: PurchaseProposalDTO): Promise<PurchaseDTO> {
    try {
      return await this.api.proposePurchase(proposal);
    } catch (err) {
      // A strict validator may only accept http(s) image URLs: retry once without the (data:) image.
      if (err instanceof GatewayApiError && err.status === 400 && proposal.imageUrl) {
        return this.api.proposePurchase({ ...proposal, imageUrl: undefined });
      }
      throw err;
    }
  }

  /** The AI review behind a freeze or a pause that never lifted, from GET /api/tabs/:id (best effort). */
  private async reviewFor(reason: string): Promise<string | null> {
    if (reason !== "tab_frozen" && reason !== "paused_timeout") return null;
    try {
      const tab = await this.api.tab(this.opts.tabId);
      const review = [...(tab.reviews ?? [])].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!review) return null;
      if (reason === "paused_timeout" && review.status === "running") return "The AI review is still running.";
      const explains = reason === "tab_frozen" ? review.verdict === "freeze" : review.verdict === "escalate";
      if (!explains) return null;
      const fault = review.fault && review.fault !== "none" ? ` (${review.fault} fault)` : "";
      const why = review.reason ? `: ${truncate(review.reason, 200).replace(/[.!\s]+$/, "")}` : "";
      return `AI review: ${review.verdict}${fault}${why}.`;
    } catch {
      return null;
    }
  }

  private purchaseSummary(product: ProductView, offer: OfferView): string {
    return `research ${formatUsd(this.state.spentMicros)} → purchase ${formatCents(offer.priceCents)}: ${product.title}${offer.domain ? ` from ${offer.domain}` : ""} (${this.callStats()}).`;
  }
}

export function searchKey(query: string, maxPriceCents: number | null): string {
  return `${query.trim().toLowerCase().replace(/\s+/g, " ")}|${maxPriceCents ?? ""}`;
}

function priceText(product: ProductView): string {
  const offer = bestOffer(product);
  return offer ? formatCents(offer.priceCents) : "(no price)";
}

