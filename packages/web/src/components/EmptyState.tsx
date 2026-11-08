/**
 * Empty, error or "not yet" placeholder inside a card or page.
 *   <EmptyState title="No vouchers yet" description="Run an agent to see paid calls arrive." action={<Button>Run agent</Button>} />
 * Options: tone "danger" colors the title; `compact` for tight spots (cards, side panels); align "start"
 * left-aligns it. For thrown errors use <ErrorState error={…} /> instead.
 */
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  tone?: "default" | "danger";
  compact?: boolean;
  align?: "center" | "start";
  className?: string;
}

export function EmptyState({ title, description, action, tone = "default", compact = false, align = "center", className }: EmptyStateProps) {
  return (
    <div
      className={["ui-empty", compact && "ui-empty--compact", align === "start" && "ui-empty--start", className].filter(Boolean).join(" ")}
      data-tone={tone}
    >
      <p className="ui-empty-title">{title}</p>
      {description != null ? <p className="ui-empty-description">{description}</p> : null}
      {action != null ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
