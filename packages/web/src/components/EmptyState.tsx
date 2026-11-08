/**
 * Empty, error or "not yet" placeholder inside a card or page.
 *   <EmptyState title="No vouchers yet" description="Run an agent to see paid calls arrive." action={<Button>Run agent</Button>} />
 */
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div className={["ui-empty", className].filter(Boolean).join(" ")}>
      <p className="ui-empty-title">{title}</p>
      {description != null ? <p className="ui-empty-description">{description}</p> : null}
      {action != null ? <div className="ui-empty-action">{action}</div> : null}
    </div>
  );
}
