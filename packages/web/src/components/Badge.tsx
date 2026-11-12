/**
 * Pill-shaped status label. Tones: neutral | accent | success | warning | danger. `dot` adds a status dot.
 *   <Badge tone="danger" dot>Voided</Badge>   <Pill tone="accent">PayPal sandbox</Pill>
 * Use the helpers for domain statuses so every page labels them the same way:
 *   TabStatusBadge, VoucherStatusBadge (optional voidReason), PurchaseStatusBadge, PayoutStatusBadge,
 *   ReviewVerdictBadge, AgentRunStatusBadge, SellerStatusBadge, SettlementStatusBadge.
 */
import type { AgentRunDTO, PayoutDTO, PurchaseDTO, ReviewVerdict, SellerDTO, SettlementDTO, TabStatus, VoucherStatus } from "@p402/shared";
import type { ReactNode } from "react";
import { voidReasonLabel } from "../lib/format";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}

export function Badge({ tone = "neutral", dot = false, title, className, children }: BadgeProps) {
  return (
    <span className={["ui-badge", className].filter(Boolean).join(" ")} data-tone={tone} title={title}>
      {dot ? <span className="ui-badge-dot" aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

export const Pill = Badge;

type BadgeSpec = { label: string; tone: BadgeTone };

export const TAB_STATUS_BADGE: Record<TabStatus, BadgeSpec> = {
  pending_approval: { label: "Awaiting approval", tone: "warning" },
  active: { label: "Active", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  frozen: { label: "Frozen", tone: "danger" },
  closing: { label: "Closing", tone: "accent" },
  settled: { label: "Settled", tone: "neutral" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function TabStatusBadge({ status }: { status: TabStatus }) {
  const { label, tone } = TAB_STATUS_BADGE[status] ?? { label: status, tone: "neutral" };
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function VoucherStatusBadge({ status, voidReason }: { status: VoucherStatus; voidReason?: string | null }) {
  if (status === "accepted") return <Badge tone="success">Accepted</Badge>;
  return <Badge tone="danger">{voidReason ? `Voided · ${voidReasonLabel(voidReason)}` : "Voided"}</Badge>;
}

export const PURCHASE_STATUS_BADGE: Record<PurchaseDTO["status"], BadgeSpec> = {
  proposed: { label: "Proposed", tone: "accent" },
  awaiting_approval: { label: "Awaiting approval", tone: "warning" },
  captured: { label: "Purchased", tone: "success" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

/** A paid purchase reads Refunded or Partly refunded once money went back to the buyer. */
export function purchaseStatusSpec(purchase: Pick<PurchaseDTO, "status" | "amountCents" | "refundedCents">): BadgeSpec {
  const refunded = purchase.refundedCents ?? 0;
  if (purchase.status === "captured" && refunded > 0) {
    return refunded >= purchase.amountCents ? { label: "Refunded", tone: "neutral" } : { label: "Partly refunded", tone: "warning" };
  }
  return PURCHASE_STATUS_BADGE[purchase.status] ?? { label: purchase.status, tone: "neutral" };
}

export function PurchaseStatusBadge({ purchase }: { purchase: Pick<PurchaseDTO, "status" | "amountCents" | "refundedCents"> }) {
  const { label, tone } = purchaseStatusSpec(purchase);
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export const PAYOUT_STATUS_BADGE: Record<PayoutDTO["status"], BadgeSpec> = {
  pending: { label: "Pending", tone: "warning" },
  success: { label: "Paid", tone: "success" },
  partial: { label: "Partly paid", tone: "warning" },
  failed: { label: "Failed", tone: "danger" },
};

export function PayoutStatusBadge({ status }: { status: PayoutDTO["status"] }) {
  const { label, tone } = PAYOUT_STATUS_BADGE[status] ?? { label: status, tone: "neutral" };
  return <Badge tone={tone}>{label}</Badge>;
}

export const REVIEW_VERDICT_BADGE: Record<ReviewVerdict, BadgeSpec> = {
  resume: { label: "Resumed", tone: "success" },
  void: { label: "Bad calls voided", tone: "accent" },
  freeze: { label: "Agent frozen", tone: "danger" },
  escalate: { label: "Needs your decision", tone: "warning" },
};

export function ReviewVerdictBadge({ verdict }: { verdict: ReviewVerdict }) {
  const { label, tone } = REVIEW_VERDICT_BADGE[verdict] ?? { label: verdict, tone: "neutral" };
  return <Badge tone={tone}>{label}</Badge>;
}

export const AGENT_RUN_STATUS_BADGE: Record<AgentRunDTO["status"], BadgeSpec> = {
  running: { label: "Running", tone: "accent" },
  finished: { label: "Finished", tone: "success" },
  stopped: { label: "Stopped", tone: "neutral" },
  failed: { label: "Failed", tone: "danger" },
};

export function AgentRunStatusBadge({ status }: { status: AgentRunDTO["status"] }) {
  const { label, tone } = AGENT_RUN_STATUS_BADGE[status] ?? { label: status, tone: "neutral" };
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function SellerStatusBadge({ status }: { status: SellerDTO["status"] }) {
  return status === "active" ? (
    <Badge tone="success" dot>
      Active
    </Badge>
  ) : (
    <Badge dot>Paused</Badge>
  );
}

export const SETTLEMENT_STATUS_BADGE: Record<SettlementDTO["status"], BadgeSpec> = {
  pending: { label: "Charging", tone: "warning" },
  completed: { label: "Charged", tone: "success" },
  failed: { label: "Charge failed", tone: "danger" },
};

export function SettlementStatusBadge({ status }: { status: SettlementDTO["status"] }) {
  const { label, tone } = SETTLEMENT_STATUS_BADGE[status] ?? { label: status, tone: "neutral" };
  return <Badge tone={tone}>{label}</Badge>;
}
