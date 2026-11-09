/** React cell renderers shared by the terminal grids. Visible rows only, so they stay cheap. */
import type { CustomCellRendererProps } from "ag-grid-react";
import { Badge, type BadgeTone, Money } from "../../components";
import { numericValue, ROW_REVIEW, type RowReview, voidReasonLabel } from "./labels";
import type { VoucherRow } from "./store";

/**
 * Money from micros (sub-cent digits muted); voided leaf rows show the price struck through. Padded to three
 * decimals so a column of $0.005 / $0.01 / $0.002 lines up on the decimal point.
 */
export function MoneyCell(props: CustomCellRendererProps<VoucherRow>) {
  const micros = numericValue(props.value);
  if (micros == null) return null;
  const voided = !props.node.group && props.data?.status === "voided" && props.column?.getColId() === "priceMicros";
  return <Money micros={Math.round(micros)} padTo={3} className={voided ? "tx-money-void" : undefined} />;
}

/** Money from whole cents (settlements, payouts). */
export function CentsCell(props: CustomCellRendererProps) {
  const cents = numericValue(props.value);
  if (cents == null) return null;
  return <Money cents={Math.round(cents)} />;
}

/**
 * Accepted as a quiet dot and label (the normal case), or the void reason as a filled danger pill (the row
 * itself is tinted and its price struck through), so the exceptions are what the eye finds.
 */
export function StatusCell(props: CustomCellRendererProps<VoucherRow>) {
  const status = props.value as VoucherRow["status"] | undefined;
  if (!status) return null;
  if (status === "accepted") {
    return (
      <Badge tone="success" dot className="tx-ok">
        Accepted
      </Badge>
    );
  }
  const reason = props.data?.voidReason;
  return (
    <Badge tone="danger" dot className="tx-reason" title={`Voided: ${reason ? voidReasonLabel(reason) : "not billed"}`}>
      {reason ? voidReasonLabel(reason) : "Voided"}
    </Badge>
  );
}

export function RequestCell(props: CustomCellRendererProps<VoucherRow>) {
  if (!props.data) return null;
  return (
    <span className="tx-request">
      <span className="tx-method" data-method={props.data.method}>
        {props.data.method}
      </span>
      <span className="tx-path">{props.data.path}</span>
    </span>
  );
}

export function ReviewCell(props: CustomCellRendererProps<VoucherRow>) {
  const state = props.value as RowReview | null | undefined;
  if (!state || !ROW_REVIEW[state]) return null;
  const { label, tone, hint } = ROW_REVIEW[state];
  return (
    <Badge tone={tone} dot={state === "reviewing"} className={state === "reviewing" ? "tx-live" : undefined} title={`${hint}. Expand the row to read the debate.`}>
      {label}
    </Badge>
  );
}

export function StatusBadgeCell({ value, map }: { value: unknown; map: Record<string, { label: string; tone: BadgeTone }> }) {
  if (typeof value !== "string" || !map[value]) return null;
  const { label, tone } = map[value];
  return <Badge tone={tone}>{label}</Badge>;
}
