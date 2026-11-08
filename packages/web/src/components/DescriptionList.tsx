/**
 * Term / value pairs with hairlines between rows; values right-aligned with tabular figures.
 *   <DescriptionList items={[
 *     { term: "Hold", detail: <Money cents={5000} /> },
 *     { term: "Honor window", detail: "ends in 2 d", hint: "Nov 11, 14:03" },
 *   ]} />
 */
import { Fragment, type ReactNode } from "react";

export interface DescriptionItem {
  term: ReactNode;
  detail: ReactNode;
  /** Small muted line under the detail. */
  hint?: ReactNode;
  key?: string;
}

export function DescriptionList({ items, dense = false, className }: { items: DescriptionItem[]; dense?: boolean; className?: string }) {
  return (
    <dl className={["ui-dl", className].filter(Boolean).join(" ")} data-dense={dense || undefined}>
      {items.map((item, i) => (
        <Fragment key={item.key ?? (typeof item.term === "string" ? item.term : i)}>
          <dt>{item.term}</dt>
          <dd>
            {item.detail}
            {item.hint != null ? <small>{item.hint}</small> : null}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}
