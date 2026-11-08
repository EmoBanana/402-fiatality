/**
 * In-process agent runs (SPEC §5.6). Each run gets its own agent id and Ed25519 key pair: the public key is
 * registered on the tab directly (no enroll token needed in-process), the private key only ever lives in this
 * process's memory. The agent pays through the public paywall like any external agent would.
 */
import { generateAgentKeyPair } from "@p402/shared/node";
import { newId, type AgentRunCreateDTO, type AgentRunDTO, type AgentStepDTO } from "@p402/shared";
import { z } from "zod";
import type { AgentRunResult, AppContext } from "../context";
import { stmt, tx } from "../db/db";
import { agentRunDTO, agentStepRow, type AgentRunRow } from "../db/dto";
import { conflict, notFound } from "../http/errors";
import { getTabRow } from "../tabs/state";

export const MAX_CONCURRENT_RUNS = 3;
const STOP_WAIT_MS = 3_000;
const MAX_STEP_TEXT = 4_000;

export const agentRunCreateSchema = z.object({
  tabId: z.string().min(1).max(64),
  task: z.string().trim().min(1).max(2_000),
  mode: z.enum(["llm", "scripted", "runaway"]),
  maxSteps: z.number().int().min(1).max(200).optional(),
});

export interface AgentRunner {
  start(body: AgentRunCreateDTO | unknown): AgentRunDTO;
  /** Abort the run and wait briefly for it to wind down. */
  stop(runId: string): Promise<AgentRunDTO>;
  get(runId: string): AgentRunDTO;
  list(filter?: { tabId?: string }): AgentRunDTO[];
  /** Resolves once no run is active (tests, shutdown). */
  idle(): Promise<void>;
  shutdown(): void;
}

interface ActiveRun {
  controller: AbortController;
  promise: Promise<void>;
}

const RESULT_STATUSES = new Set(["finished", "stopped", "failed"]);

export function createAgentRunner(ctx: AppContext, opts: { gatewayUrl: () => string; maxConcurrent?: number }): AgentRunner {
  const maxConcurrent = opts.maxConcurrent ?? MAX_CONCURRENT_RUNS;
  const active = new Map<string, ActiveRun>();
  let closed = false;

  const row = (runId: string) => stmt(ctx.db, "SELECT * FROM agent_runs WHERE id = ?").get(runId) as AgentRunRow | undefined;

  function finish(runId: string, result: AgentRunResult): void {
    if (closed) return;
    const status = RESULT_STATUSES.has(result.status) ? result.status : "failed";
    const summary = typeof result.summary === "string" ? result.summary.slice(0, 2_000) : "";
    const changed = stmt(
      ctx.db,
      `UPDATE agent_runs SET status = ?, spent_micros = ?, result = ?, error = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    ).run(
      status,
      Number.isSafeInteger(result.spentMicros) ? result.spentMicros : 0,
      JSON.stringify({ summary, purchaseId: result.purchaseId ?? null }),
      result.error ? String(result.error).slice(0, 1_000) : null,
      ctx.clock.now(),
      runId,
    ).changes;
    if (changed > 0) ctx.bus.emit("agent.finished", agentRunDTO(ctx.db, row(runId) as AgentRunRow));
  }

  return {
    start(body) {
      if (closed) throw conflict("shutting_down", "The gateway is shutting down.");
      const input = agentRunCreateSchema.parse(body);
      const tab = getTabRow(ctx, input.tabId);
      if (!tab) throw notFound("Tab", input.tabId);
      if (tab.status !== "active") {
        throw conflict("tab_not_active", `The tab is ${tab.status.replace("_", " ")}: agents can only spend on an active tab.`);
      }
      if (active.size >= maxConcurrent) throw conflict("too_many_runs", `At most ${maxConcurrent} agents can run at once.`);

      const runId = newId("run");
      const agentId = newId("agent", 12);
      const keys = generateAgentKeyPair();
      const now = ctx.clock.now();
      tx(ctx.db, () => {
        stmt(ctx.db, "INSERT INTO agent_keys (tab_id, agent_id, public_key, created_at) VALUES (?, ?, ?, ?)").run(tab.id, agentId, keys.publicKey, now);
        stmt(
          ctx.db,
          "INSERT INTO agent_runs (id, tab_id, agent_id, task, mode, status, spent_micros, created_at) VALUES (?, ?, ?, ?, ?, 'running', 0, ?)",
        ).run(runId, tab.id, agentId, input.task, input.mode, now);
      });

      const controller = new AbortController();
      let index = 0;
      let spent = 0;
      const onStep = (step: AgentStepDTO) => {
        if (closed) return;
        try {
          const normalized: AgentStepDTO = {
            ...step,
            runId,
            index: index++,
            text: String(step.text ?? "").slice(0, MAX_STEP_TEXT),
            at: ctx.clock.now(), // gateway time, like every other stored timestamp (the demo clock may be ahead)
          };
          if (normalized.kind === "paid_call" && normalized.status === "accepted" && Number.isSafeInteger(normalized.costMicros)) {
            spent += normalized.costMicros as number;
          }
          const r = agentStepRow(normalized);
          tx(ctx.db, () => {
            stmt(ctx.db, "INSERT INTO agent_steps (run_id, idx, kind, text, data, at) VALUES (?, ?, ?, ?, ?, ?)").run(r.run_id, r.idx, r.kind, r.text, r.data, r.at);
            stmt(ctx.db, "UPDATE agent_runs SET spent_micros = ? WHERE id = ? AND status = 'running'").run(spent, runId);
          });
          ctx.bus.emit("agent.step", normalized);
        } catch (err) {
          ctx.log.warn({ err, runId }, "could not record an agent step");
        }
      };

      const promise = Promise.resolve()
        .then(() =>
          ctx.runAgent({
            runId,
            gatewayUrl: opts.gatewayUrl(),
            tabId: tab.id,
            agentId,
            privateKey: keys.privateKey,
            task: input.task,
            mode: input.mode,
            llm: ctx.ai.llm,
            maxSteps: input.maxSteps,
            taskId: runId,
            apiHeaders: ctx.config.demo || !ctx.config.adminToken ? undefined : { "x-p402-admin": ctx.config.adminToken },
            signal: controller.signal,
            onStep,
          }),
        )
        .then(
          (result) => finish(runId, result),
          (err: unknown) =>
            finish(runId, {
              status: controller.signal.aborted ? "stopped" : "failed",
              summary: "",
              spentMicros: spent,
              error: err instanceof Error ? err.message : String(err),
            }),
        )
        .catch((err) => ctx.log.error({ err, runId }, "agent run bookkeeping failed"))
        .finally(() => active.delete(runId));
      active.set(runId, { controller, promise });
      return agentRunDTO(ctx.db, row(runId) as AgentRunRow);
    },

    async stop(runId) {
      if (!row(runId)) throw notFound("Agent run", runId);
      const run = active.get(runId);
      if (run) {
        run.controller.abort();
        await Promise.race([run.promise, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS).unref())]);
      }
      return agentRunDTO(ctx.db, row(runId) as AgentRunRow);
    },

    get(runId) {
      const r = row(runId);
      if (!r) throw notFound("Agent run", runId);
      return agentRunDTO(ctx.db, r);
    },

    list(filter = {}) {
      const rows = (
        filter.tabId
          ? stmt(ctx.db, "SELECT * FROM agent_runs WHERE tab_id = ? ORDER BY created_at DESC LIMIT 200").all(filter.tabId)
          : stmt(ctx.db, "SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT 200").all()
      ) as AgentRunRow[];
      return rows.map((r) => agentRunDTO(ctx.db, r, { steps: false }));
    },

    async idle() {
      while (active.size > 0) await Promise.allSettled([...active.values()].map((r) => r.promise));
    },

    shutdown() {
      if (closed) return;
      closed = true;
      for (const [runId, run] of active) {
        run.controller.abort();
        try {
          stmt(ctx.db, "UPDATE agent_runs SET status = 'stopped', error = 'gateway stopped', finished_at = ? WHERE id = ? AND status = 'running'").run(
            ctx.clock.now(),
            runId,
          );
        } catch (err) {
          ctx.log.warn({ err, runId }, "could not mark an agent run stopped");
        }
      }
    },
  };
}

/** Runs left `running` by a crash can't be resumed (their keys were in memory): mark them failed. */
export function recoverInterruptedRuns(ctx: AppContext): number {
  return stmt(ctx.db, "UPDATE agent_runs SET status = 'failed', error = 'gateway restarted', finished_at = ? WHERE status = 'running'").run(
    ctx.clock.now(),
  ).changes;
}
