/**
 * An agent run as it happens: the agent's reasoning between the paid calls it makes, each call printed like
 * a line on the IOU tape (seller, endpoint, cost, running total), voids struck through in red.
 */
import type { AgentRunDTO, AgentStepDTO } from "@p402/shared";
import { useEffect, useLayoutEffect, useRef } from "react";
import { Money } from "../../components/Money";
import { formatTime, voidReasonLabel } from "../../lib/format";

const KIND_LABEL: Record<AgentStepDTO["kind"], string> = {
  thought: "Thinks",
  paid_call: "Pays",
  decision: "Decides",
  purchase_proposal: "Proposes",
  paused: "Waits",
  error: "Error",
  finished: "Done",
};

function Step({ step }: { step: AgentStepDTO }) {
  const voided = step.kind === "paid_call" && step.status === "voided";
  if (step.kind === "paid_call") {
    return (
      <li className="cs-feed-row cs-feed-call" data-void={voided || undefined}>
        <time className="cs-feed-time">{formatTime(step.at)}</time>
        <span className="cs-feed-kind">{KIND_LABEL.paid_call}</span>
        <span className="cs-feed-main">
          <span className="cs-feed-endpoint">
            {step.sellerId ? <b>{step.sellerId}</b> : null} {step.endpoint ?? ""}
          </span>
          <span className="cs-feed-text">{voided ? `Voided: ${voidReasonLabel(step.voidReason)}` : step.text}</span>
        </span>
        <span className="cs-feed-cost">{typeof step.costMicros === "number" ? <Money micros={step.costMicros} padTo={3} /> : null}</span>
        <span className="cs-feed-cum">{typeof step.cumulativeMicros === "number" ? <Money micros={step.cumulativeMicros} padTo={3} /> : null}</span>
      </li>
    );
  }
  return (
    <li className="cs-feed-row cs-feed-note" data-kind={step.kind}>
      <time className="cs-feed-time">{formatTime(step.at)}</time>
      <span className="cs-feed-kind">{KIND_LABEL[step.kind]}</span>
      <p className="cs-feed-main cs-feed-prose">{step.text}</p>
    </li>
  );
}

export function StepFeed({ run }: { run: AgentRunDTO }) {
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  const count = run.steps.length;

  // Follow new steps while the reader is at the bottom; leave them alone once they scroll up.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <div className="cs-feed">
      <div className="cs-feed-cols" aria-hidden="true">
        <span>Time</span>
        <span className="cs-feed-kind" />
        <span>Step</span>
        <span className="is-num">Cost</span>
        <span className="is-num">Run total</span>
      </div>
      <ol ref={listRef} className="cs-feed-list" aria-label="Agent steps" tabIndex={0}>
        {run.steps.map((step) => (
          <Step key={step.index} step={step} />
        ))}
        {run.status === "running" ? (
          <li className="cs-feed-row cs-feed-note cs-feed-waiting">
            <span className="cs-feed-time" />
            <span className="cs-feed-kind" />
            <p className="cs-feed-main cs-feed-prose muted">
              <span className="cs-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>{" "}
              Working
            </p>
          </li>
        ) : null}
      </ol>
    </div>
  );
}
