/**
 * Page title row. <PageHeader title="Clearing terminal" description="Every IOU, live." actions={<Button>Export</Button>} />
 */
import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="ui-page-head">
      <div>
        <h1>{title}</h1>
        {description != null ? <p>{description}</p> : null}
      </div>
      {actions != null ? <div>{actions}</div> : null}
    </div>
  );
}
