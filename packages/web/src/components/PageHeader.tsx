/**
 * Page title row.
 *   <PageHeader eyebrow="Buyer" title="Clearing terminal" description="Every IOU, live." actions={<Button>Export</Button>} />
 */
import type { ReactNode } from "react";

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small uppercase label above the title. */
  eyebrow?: ReactNode;
}

export function PageHeader({ title, description, actions, eyebrow }: PageHeaderProps) {
  return (
    <div className="ui-page-head">
      <div style={{ minWidth: 0 }}>
        {eyebrow != null ? <span className="ui-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description != null ? <p>{description}</p> : null}
      </div>
      {actions != null ? <div className="ui-page-head-actions">{actions}</div> : null}
    </div>
  );
}
