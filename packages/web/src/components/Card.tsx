/**
 * Surface with an optional header and footer. padding: "md" (default) | "lg" | "none" (tables and grids).
 *   <Card title="Tab" subtitle="Hold placed Nov 8" actions={<Button size="sm">Close tab</Button>}
 *     footer={<Link to="/statements/tab_1">View statement</Link>}>…</Card>
 * `titleAs` picks the heading level (default h2).
 */
import type { HTMLAttributes, ReactNode } from "react";

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  padding?: "none" | "md" | "lg";
  titleAs?: "h2" | "h3" | "h4";
}

export function Card({ title, subtitle, actions, footer, padding = "md", titleAs: Title = "h2", className, children, ...rest }: CardProps) {
  const hasHead = title != null || subtitle != null || actions != null;
  return (
    <section className={["ui-card", className].filter(Boolean).join(" ")} {...rest}>
      {hasHead ? (
        <header className="ui-card-head">
          <div style={{ minWidth: 0 }}>
            {title != null ? <Title className="ui-card-title">{title}</Title> : null}
            {subtitle != null ? <p className="ui-card-subtitle">{subtitle}</p> : null}
          </div>
          {actions != null ? <div className="ui-card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={["ui-card-body", padding !== "md" && `ui-card-body--${padding}`].filter(Boolean).join(" ")}>{children}</div>
      {footer != null ? <footer className="ui-card-foot">{footer}</footer> : null}
    </section>
  );
}
