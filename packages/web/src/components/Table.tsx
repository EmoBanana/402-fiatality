/**
 * Simple data table for short lists (use AG Grid for live or large data).
 *   <Table rows={lines} rowKey={(l) => l.sellerId} empty={<EmptyState title="No sellers yet" />}
 *     columns={[{ key: "seller", header: "Seller", render: (l) => l.sellerName },
 *               { key: "net", header: "Net", align: "right", render: (l) => <Money micros={l.netMicros} /> }]} />
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
  caption?: string;
  className?: string;
}

export function Table<T>({ columns, rows, rowKey, empty, dense = false, onRowClick, caption, className }: TableProps<T>) {
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
            <tr key={rowKey(row, i)} data-clickable={onRowClick ? true : undefined} onClick={onRowClick ? () => onRowClick(row) : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={alignClass(c.align)}>
                  {c.render(row, i)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
