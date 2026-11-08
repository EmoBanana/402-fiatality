/**
 * Simple data table for short lists (use AG Grid for live or large data).
 *   <Table rows={lines} rowKey={(l) => l.sellerId} empty={<EmptyState title="No sellers yet" />}
 *     columns={[{ key: "seller", header: "Seller", render: (l) => l.sellerName },
 *               { key: "net", header: "Net", align: "right", render: (l) => <Money micros={l.netMicros} /> }]}
 *     footer={{ seller: "Total", net: <Money micros={total} /> }} footerVariant="grand" />
 * `footer` renders a totals row keyed by column (single rule above; "grand" adds the double rule below, the
 * accounting mark for a final figure). `rowTone` tints a row ("danger" for voids, "muted" for inactive).
 * Clickable rows (`onRowClick`) are focusable and open with Enter.
 */
import type { ReactNode } from "react";

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  align?: "left" | "right" | "center";
  width?: number | string;
}

export interface TableProps<T> {
  columns: TableColumn<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string;
  /** Shown instead of the body when there are no rows. */
  empty?: ReactNode;
  dense?: boolean;
  onRowClick?: (row: T) => void;
  /** Accessible name for clickable rows, e.g. (row) => `Open payout ${row.id}`. */
  rowLabel?: (row: T) => string;
  rowTone?: (row: T) => "danger" | "muted" | undefined;
  footer?: Partial<Record<string, ReactNode>>;
  footerVariant?: "total" | "grand";
  caption?: string;
  className?: string;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty,
  dense = false,
  onRowClick,
  rowLabel,
  rowTone,
  footer,
  footerVariant = "total",
  caption,
  className,
}: TableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  const alignClass = (align?: TableColumn<T>["align"]) => (align === "right" ? "is-right" : align === "center" ? "is-center" : undefined);
  return (
    <div className={["ui-table-wrap", className].filter(Boolean).join(" ")}>
      <table className="ui-table" data-dense={dense || undefined}>
        {caption ? <caption className="visually-hidden">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={alignClass(c.align)} style={c.width != null ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              data-clickable={onRowClick ? true : undefined}
              data-tone={rowTone?.(row)}
              tabIndex={onRowClick ? 0 : undefined}
              aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRowClick(row);
                      }
                    }
                  : undefined
              }
            >
              {columns.map((c) => (
                <td key={c.key} className={alignClass(c.align)}>
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr data-variant={footerVariant}>
              {columns.map((c) => (
                <td key={c.key} className={alignClass(c.align)}>
                  {footer[c.key] ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
