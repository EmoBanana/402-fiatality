/**
 * An inline message inside a page or card: notes, warnings, the paused-tab banner.
 *   <Callout tone="warning" title="Tab paused" actions={<Button size="sm">Resume</Button>}>Gemma is reviewing…</Callout>
 * Tones: neutral (default) | accent | success | warning | danger. Use role="alert" only for urgent errors.
 */
import type { HTMLAttributes, ReactNode } from "react";

export type CalloutTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  tone?: CalloutTone;
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}

export function Callout({ tone = "neutral", title, actions, children, className, ...rest }: CalloutProps) {
  return (
    <div className={["ui-callout", className].filter(Boolean).join(" ")} data-tone={tone} {...rest}>
      <span className="ui-callout-mark" aria-hidden="true" />
      <div className="ui-callout-body">
        {title != null ? <p className="ui-callout-title">{title}</p> : null}
        {children != null ? <div className="ui-callout-text">{children}</div> : null}
      </div>
      {actions != null ? <div className="ui-callout-actions">{actions}</div> : null}
    </div>
  );
}
