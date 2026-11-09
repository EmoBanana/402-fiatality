/**
 * Step 4: run an agent against the tab (Gemma, scripted, or a deliberate runaway) and watch every paid call
 * with its cost. Also shows how to point your own agent at the tab from the terminal.
 */
import type { AgentMode, AgentRunDTO, TabDetailDTO } from "@p402/shared";
import { useEffect, useState } from "react";
import { AgentRunStatusBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { CopyButton } from "../../components/CopyButton";
import { EmptyState } from "../../components/EmptyState";
import { describeError } from "../../components/ErrorState";
import { Select, Textarea } from "../../components/Field";
import { Money } from "../../components/Money";
import { Segmented } from "../../components/Segmented";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { useGatewayConfig } from "../../lib/config";
import { formatTime, modelLabel, plural } from "../../lib/format";
import { useEnrollToken } from "./session";
import { StepFeed } from "./StepFeed";

const DEFAULT_TASK: Record<AgentMode, string> = {
  llm: "Find the best espresso machine under $200 and propose a purchase.",
  scripted: "Find the best espresso machine under $200 and propose a purchase.",
  runaway: "Search for espresso machines.",
};

const MODE_HINT: Record<AgentMode, string> = {
  llm: "decides each paid call and says why it's worth the price.",
  scripted: "A fixed demo sequence: search, three product details, price history, reviews (some fail and are voided).",
  runaway: "Repeats the same paid search to trip the loop alarm, pause the tab and start an AI review.",
};

const MODE_LABEL: Record<AgentMode, string> = { llm: "Gemma 4", scripted: "Scripted", runaway: "Runaway" };

/** True when the run's summary is already the feed's last line ("Done …"), so the card doesn't print it twice. */
function summaryIsLastStep(run: AgentRunDTO): boolean {
  const last = run.steps.at(-1);
  const summary = run.result?.summary?.trim();
  return !run.error && !!summary && last?.kind === "finished" && last.text.trim() === summary;
}

export interface AgentPanelProps {
  tab: TabDetailDTO;
  runs: AgentRunDTO[];
  onRun: (run: AgentRunDTO) => void;
}

export function AgentPanel({ tab, runs, onRun }: AgentPanelProps) {
  const toast = useToast();
  const config = useGatewayConfig().data;
  const token = useEnrollToken(tab.id);
  const [mode, setMode] = useState<AgentMode>("llm");
  const [task, setTask] = useState(DEFAULT_TASK.llm);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const modelName = config ? (config.llm.provider === "mock" ? "The mock model" : modelLabel(config.llm.model)) : "Gemma 4";
  const llmOption = config?.llm.provider === "mock" ? "Mock LLM" : modelName.replace(/ · .*/, "");
  const run = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null;
  const runningCount = runs.filter((r) => r.status === "running").length;

  // Follow the newest run when one starts.
  const newestId = runs[0]?.id ?? null;
  useEffect(() => setSelectedId(newestId), [newestId]);

  const blocked =
    tab.status === "pending_approval"
      ? "Approve the PayPal hold first."
      : tab.status === "paused"
        ? "Paused while the review decides. Runs continue once the tab resumes."
        : tab.status === "frozen"
          ? "This tab is frozen; no more spending."
          : tab.status !== "active"
            ? "This tab is closed."
            : runningCount >= 3
              ? "Three agents are already running on this tab."
              : null;

  function changeMode(next: AgentMode) {
    if (task.trim() === DEFAULT_TASK[mode] || !task.trim()) setTask(DEFAULT_TASK[next]);
    setMode(next);
  }

  async function start() {
    setStarting(true);
    try {
      const created = await api.agentRuns.create({ tabId: tab.id, task: task.trim() || DEFAULT_TASK[mode], mode });
      onRun(created);
      setSelectedId(created.id);
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't start the agent") });
    } finally {
      setStarting(false);
    }
  }

  async function stop(id: string) {
    setStopping(true);
    try {
      onRun(await api.agentRuns.stop(id));
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't stop the agent") });
    } finally {
      setStopping(false);
    }
  }

  const calls = run ? run.steps.filter((s) => s.kind === "paid_call") : [];
  const voids = calls.filter((s) => s.status === "voided").length;

  const canSpend = tab.status === "active" || tab.status === "paused" || tab.status === "frozen";

  if (tab.status === "pending_approval") {
    return <p className="muted cs-note">Available once PayPal approves the hold.</p>;
  }
  if (!canSpend && runs.length === 0) {
    return <p className="muted cs-note">No agent ran on this tab.</p>;
  }

  return (
    <div className="cs-agent">
      {canSpend ? (
        <div className="ui-card cs-agent-form">
          <Textarea label="Task" rows={2} value={task} onChange={(e) => setTask(e.target.value)} maxLength={500} />
          <div className="cs-agent-controls">
            <Segmented
              label="Mode"
              value={mode}
              onChange={changeMode}
              options={(["llm", "scripted", "runaway"] as const).map((m) => ({ value: m, label: m === "llm" ? llmOption : MODE_LABEL[m] }))}
            />
            <Button variant="primary" onClick={start} loading={starting} disabled={Boolean(blocked)}>
              Run agent
            </Button>
          </div>
          <p className="cs-note muted">{mode === "llm" ? `${modelName} ${MODE_HINT.llm}` : MODE_HINT[mode]}</p>
          {blocked ? <p className="cs-note cs-blocked">{blocked}</p> : null}
        </div>
      ) : null}

      {run ? (
        <div className="ui-card cs-run">
          <header className="cs-run-head">
            <div className="cs-run-title">
              {runs.length > 1 ? (
                <Select label="Run" value={run.id} onChange={(e) => setSelectedId(e.target.value)} className="cs-run-select">
                  {runs.map((r, i) => (
                    <option key={r.id} value={r.id}>
                      Run {runs.length - i} · {MODE_LABEL[r.mode]} · {formatTime(r.createdAt)}
                    </option>
                  ))}
                </Select>
              ) : (
                <p className="cs-run-name">
                  {MODE_LABEL[run.mode]} run <span className="muted">· started {formatTime(run.createdAt)}</span>
                </p>
              )}
              <p className="cs-run-task" title={run.task}>
                {run.task}
              </p>
            </div>
            <div className="cs-run-stats">
              <span>
                <span className="muted">Spent</span> <Money micros={run.spentMicros} />
              </span>
              <span className="muted">{plural(calls.length, "paid call")}</span>
              {voids ? <span className="cs-void">{voids} voided</span> : null}
              <AgentRunStatusBadge status={run.status} />
              {run.status === "running" ? (
                <Button size="sm" variant="ghost" onClick={() => stop(run.id)} loading={stopping}>
                  Stop
                </Button>
              ) : null}
            </div>
          </header>
          {run.steps.length ? (
            <StepFeed run={run} />
          ) : (
            <EmptyState compact title="Starting the agent" description="Its first paid call will appear here with the price it paid." />
          )}
          {run.status !== "running" && (run.result?.summary || run.error) && !summaryIsLastStep(run) ? (
            <p className={run.error ? "cs-run-result ui-error" : "cs-run-result"}>{run.error ?? run.result?.summary}</p>
          ) : null}
        </div>
      ) : (
        <div className="ui-card">
          <EmptyState
            title="No agent has run on this tab yet"
            description="Pick a mode and run one. Every paid call lands here with what it cost and the running total."
          />
        </div>
      )}

      {token ? (
        <details className="cs-cli">
          <summary>Run your own agent from a terminal</summary>
          <p className="muted">This enroll token lets an agent register its signing key on this tab. It's shown once; keep it private.</p>
          <div className="cs-cli-command">
            <code>{`npm run agent -- --tab ${tab.id} --token ${token} --mode llm --task "${DEFAULT_TASK.llm}"`}</code>
            <CopyButton
              value={`npm run agent -- --tab ${tab.id} --token ${token} --mode llm --task "${DEFAULT_TASK.llm}"`}
              label="Copy command"
              variant="secondary"
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}
