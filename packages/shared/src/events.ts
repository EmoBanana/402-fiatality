/** Live events pushed by the gateway over the /ws WebSocket. */
import type {
  AgentRunDTO,
  AgentStepDTO,
  AlarmDTO,
  ClockDTO,
  DisputeDTO,
  MetricsSummaryDTO,
  PayoutDTO,
  PurchaseDTO,
  ReviewDTO,
  ReviewMessageDTO,
  SellerDTO,
  SettlementDTO,
  TabDTO,
  VoucherDTO,
} from "./api";

export type GatewayEvent =
  | { type: "voucher.accepted"; at: number; data: VoucherDTO }
  | { type: "voucher.voided"; at: number; data: VoucherDTO }
  | { type: "tab.updated"; at: number; data: TabDTO }
  | { type: "alarm.raised"; at: number; data: AlarmDTO }
  | { type: "review.started"; at: number; data: ReviewDTO }
  | { type: "review.message"; at: number; data: { reviewId: string; tabId: string; message: ReviewMessageDTO } }
  | { type: "review.finished"; at: number; data: ReviewDTO }
  | { type: "settlement.completed"; at: number; data: SettlementDTO }
  | { type: "payout.completed"; at: number; data: PayoutDTO }
  | { type: "seller.updated"; at: number; data: SellerDTO }
  | { type: "agent.step"; at: number; data: AgentStepDTO }
  | { type: "agent.finished"; at: number; data: AgentRunDTO }
  | { type: "purchase.updated"; at: number; data: PurchaseDTO }
  | { type: "clock.advanced"; at: number; data: ClockDTO }
  | { type: "dispute.updated"; at: number; data: DisputeDTO }
  | { type: "dispute.message"; at: number; data: { disputeId: string; message: ReviewMessageDTO } }
  | { type: "metrics"; at: number; data: MetricsSummaryDTO };

export type GatewayEventType = GatewayEvent["type"];

export type GatewayEventOf<T extends GatewayEventType> = Extract<GatewayEvent, { type: T }>;
