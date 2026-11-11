// Design system barrel. Component APIs are documented at the top of each file; keep them stable.
export { AppShell, NAV_GROUPS, NAV_LINKS, ROLES, type ViewRole } from "./AppShell";
export {
  AGENT_RUN_STATUS_BADGE,
  AgentRunStatusBadge,
  Badge,
  type BadgeTone,
  PAYOUT_STATUS_BADGE,
  PayoutStatusBadge,
  Pill,
  PURCHASE_STATUS_BADGE,
  PurchaseStatusBadge,
  REVIEW_VERDICT_BADGE,
  ReviewVerdictBadge,
  SellerStatusBadge,
  SETTLEMENT_STATUS_BADGE,
  SettlementStatusBadge,
  TAB_STATUS_BADGE,
  TabStatusBadge,
  VoucherStatusBadge,
} from "./Badge";
export { Button, buttonClassName, type ButtonSize, type ButtonVariant } from "./Button";
export { Callout, type CalloutTone } from "./Callout";
export { Card } from "./Card";
export { CopyButton } from "./CopyButton";
export { Debate, type DebateRole, DISPUTE_ROLES, readableMessage, SPEND_REVIEW_ROLES } from "./Debate";
export { type DescriptionItem, DescriptionList } from "./DescriptionList";
export { Drawer } from "./Drawer";
export { EmptyState } from "./EmptyState";
export { type DescribedError, describeError, ErrorState } from "./ErrorState";
export { Input, Select, Textarea } from "./Field";
export { Logo, Monogram } from "./Logo";
export { Meter } from "./Meter";
export { Money } from "./Money";
export { PageHeader } from "./PageHeader";
export { PagePlaceholder } from "./PagePlaceholder";
export { Segmented, type SegmentedOption } from "./Segmented";
export { Skeleton, SkeletonText } from "./Skeleton";
export { Spinner } from "./Spinner";
export { Stat } from "./Stat";
export { Switch } from "./Switch";
export { Table, type TableColumn } from "./Table";
export { ThemeToggle } from "./ThemeToggle";
export { ToastProvider, useToast, type ToastOptions } from "./Toast";
