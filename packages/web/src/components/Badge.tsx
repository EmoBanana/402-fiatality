/**
 * Pill-shaped status label. Tones: neutral | accent | success | warning | danger. `dot` adds a status dot.
 *   <Badge tone="danger" dot>Voided</Badge>   <Pill tone="accent">PayPal sandbox</Pill>
 * Use the helpers for domain statuses so every page labels them the same way.
 */
import type { TabStatus, VoucherStatus } from "@p402/shared";
import type { ReactNode } from "react";

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

export const TAB_STATUS_BADGE: Record<TabStatus, { label: string; tone: BadgeTone }> = {
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
  const { label, tone } = TAB_STATUS_BADGE[status];
  return (
    <Badge tone={tone} dot>
      {label}
    </Badge>
  );
}

export function VoucherStatusBadge({ status }: { status: VoucherStatus }) {
  return status === "accepted" ? <Badge tone="success">Accepted</Badge> : <Badge tone="danger">Voided</Badge>;
}
