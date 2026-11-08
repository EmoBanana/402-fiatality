/**
 * One numbered step of the console flow (the steps really are a sequence: company, budget, hold, agent,
 * purchase, close). Done steps show a check; the current one is ringed in the accent.
 */
import { type ReactNode, useId } from "react";
import { IconCheck } from "../../components/Icons";

export type StepState = "done" | "current" | "upcoming";

export interface StepSectionProps {
  n: number;
  title: ReactNode;
  state: StepState;
  description?: ReactNode;
  /** Right side of the title row (a summary value, a badge, a small action). */
  aside?: ReactNode;
  children?: ReactNode;
  compact?: boolean;
}

export function StepSection({ n, title, state, description, aside, children, compact = false }: StepSectionProps) {
  const id = useId();
  return (
    <section className="cs-step" data-state={state} data-compact={compact || undefined} aria-labelledby={id}>
      <div className="cs-step-marker" aria-hidden="true">
        {state === "done" ? <IconCheck size={14} /> : n}
      </div>
      <div className="cs-step-body">
        <header className="cs-step-head">
          <h2 id={id}>
            <span className="visually-hidden">
              Step {n}
              {state === "done" ? ", done" : state === "current" ? ", current" : ""}:{" "}
            </span>
            {title}
          </h2>
          {aside != null ? <div className="cs-step-aside">{aside}</div> : null}
        </header>
        {description != null ? <p className="cs-step-desc">{description}</p> : null}
        {children != null ? <div className="cs-step-content">{children}</div> : null}
      </div>
    </section>
  );
}
