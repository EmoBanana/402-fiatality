/**
 * Surface with an optional header. padding: "md" (default) | "lg" | "none" (for tables and grids).
 *   <Card title="Tab" subtitle="Hold placed Nov 8" actions={<Button size="sm">Close tab</Button>}>…</Card>
 */
import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  padding?: "none" | "md" | "lg";
}

export function Card({ title, subtitle, actions, padding = "md", className, children, ...rest }: CardProps) {
  const hasHead = title != null || subtitle != null || actions != null;
  return (
    <section className={["ui-card", className].filter(Boolean).join(" ")} {...rest}>
      {hasHead ? (
        <header className="ui-card-head">
          <div>
            {title != null ? <h2 className="ui-card-title">{title}</h2> : null}
            {subtitle != null ? <p className="ui-card-subtitle">{subtitle}</p> : null}
          </div>
          {actions != null ? <div>{actions}</div> : null}
        </header>
      ) : null}
      <div className={["ui-card-body", padding !== "md" && `ui-card-body--${padding}`].filter(Boolean).join(" ")}>{children}</div>
    </section>
  );
}
