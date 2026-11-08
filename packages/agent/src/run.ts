/**
 * runAgent (contract: RunAgent in @p402/gateway/context). One run = one RunSession driven by a mode; every
 * outcome, including stops and failures, ends with a `finished` step and an AgentRunResult.
 */
import type { AgentRunOptions, RunAgent } from "@p402/gateway/context";
import { runLlm } from "./modes/llm";
import { runRunaway } from "./modes/runaway";
import { runScripted } from "./modes/scripted";
import { type ModeOutcome, type RunDeps, RunSession, RunStop } from "./session";

/** Default caps on paid calls (scripted, runaway) or actions (llm) when `maxSteps` is not given. */
export const DEFAULT_MAX_STEPS = { llm: 14, scripted: 20, runaway: 30 } as const;

export function createRunAgent(deps: RunDeps = {}): RunAgent {
  return async (opts) => {
    const session = new RunSession(opts, deps);
    let outcome: ModeOutcome;
    try {
      await session.init();
      outcome = await runMode(session, opts);
    } catch (err) {
      outcome = await session.outcomeFor(err);
    }
    const { state } = session;
    session.steps.emit("finished", outcome.summary, {
      cumulativeMicros: state.spentMicros,
      data: { status: outcome.status, purchaseId: outcome.purchaseId ?? null, paidCalls: state.paidCalls, voidedCalls: state.voidedCalls },
    });
    return {
      status: outcome.status,
      summary: outcome.summary,
      spentMicros: state.spentMicros,
      purchaseId: outcome.purchaseId ?? null,
      error: outcome.error ?? null,
    };
  };
}

export const runAgent: RunAgent = createRunAgent();

function runMode(session: RunSession, opts: AgentRunOptions): Promise<ModeOutcome> {
  const limit = (fallback: number) => Math.min(100, Math.max(1, Math.floor(opts.maxSteps ?? fallback)));
  switch (opts.mode) {
    case "scripted":
      return runScripted(session, limit(DEFAULT_MAX_STEPS.scripted));
    case "runaway":
      return runRunaway(session, limit(DEFAULT_MAX_STEPS.runaway));
    case "llm":
      return runLlm(session, opts.llm, limit(DEFAULT_MAX_STEPS.llm));
    default:
      throw new RunStop({ status: "failed", summary: `Unknown agent mode "${String(opts.mode)}".`, error: "bad_mode" });
  }
}
