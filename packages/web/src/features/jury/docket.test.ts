import type { DisputeDTO, ReviewDTO, ReviewMessageDTO } from "@p402/shared";
import { describe, expect, it } from "vitest";
import {
  addDisputeMessage,
  addReviewMessage,
  buildDocket,
  confidencePct,
  disputeBadge,
  disputeReasonLabel,
  disputeStageLabel,
  isOpenCase,
  juryModelLabel,
  matchesFilter,
  parseFilter,
  reviewOutcome,
  sentenceCase,
  upsertDispute,
  upsertReview,
} from "./docket";

function review(over: Partial<ReviewDTO> = {}): ReviewDTO {
  return {
    id: "rev_1",
    tabId: "tab_1",
    alarmId: "alm_1",
    status: "done",
    verdict: "freeze",
    fault: "agent",
    confidence: 0.92,
    reason: "Looped.",
    voidedVoucherIds: [],
    transcript: [],
    model: "mock",
    decidedBy: "ai",
    createdAt: 1_000,
    finishedAt: 2_000,
    ...over,
  };
}

function dispute(over: Partial<DisputeDTO> = {}): DisputeDTO {
  return {
    id: "PP-D-1",
    settlementId: "stl_1",
    tabId: "tab_1",
    companyId: "co_1",
    captureId: "CAP-1",
    status: "WAITING_FOR_SELLER_RESPONSE",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    stage: "INQUIRY",
    amountCents: 500,
    outcome: null,
    refundedCents: 0,
    buyerMessage: null,
    sellerResponseDueAt: null,
    heldMicros: 5_000_000,
    jury: null,
    actions: [],
    createdAt: 1_500,
    updatedAt: 1_500,
    ...over,
  };
}

const msg = (role: ReviewMessageDTO["role"], at: number, content = role): ReviewMessageDTO => ({ role, at, content });

describe("jury docket", () => {
  it("lists reviews and disputes together, newest first", () => {
    const docket = buildDocket([review({ id: "rev_old", createdAt: 1_000 }), review({ id: "rev_new", createdAt: 3_000 })], [dispute({ createdAt: 2_000 })]);
    expect(docket.map((c) => c.id)).toEqual(["rev_new", "PP-D-1", "rev_old"]);
  });

  it("keeps a case open until someone has to do nothing more", () => {
    const tabs = new Map([
      ["tab_paused", { status: "paused" as const }],
      ["tab_settled", { status: "settled" as const }],
    ]);
    const open = (c: Parameters<typeof isOpenCase>[0]) => isOpenCase(c, tabs);
    expect(open({ kind: "review", id: "r", at: 0, review: review({ status: "running", verdict: null }) })).toBe(true);
    expect(open({ kind: "review", id: "r", at: 0, review: review({ verdict: "freeze" }) })).toBe(false);
    expect(open({ kind: "review", id: "r", at: 0, review: review({ verdict: "escalate", tabId: "tab_paused" }) })).toBe(true);
    // An escalated review on a tab that has since closed is moot.
    expect(open({ kind: "review", id: "r", at: 0, review: review({ verdict: "escalate", tabId: "tab_settled" }) })).toBe(false);
    expect(open({ kind: "dispute", id: "d", at: 0, dispute: dispute() })).toBe(true);
    expect(open({ kind: "dispute", id: "d", at: 0, dispute: dispute({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" }) })).toBe(false);
  });

  it("filters by kind and by open", () => {
    const tabs = new Map();
    const r = { kind: "review" as const, id: "r", at: 0, review: review() };
    const d = { kind: "dispute" as const, id: "d", at: 0, dispute: dispute() };
    expect([r, d].filter((c) => matchesFilter(c, "rogue", tabs))).toEqual([r]);
    expect([r, d].filter((c) => matchesFilter(c, "disputes", tabs))).toEqual([d]);
    expect([r, d].filter((c) => matchesFilter(c, "open", tabs))).toEqual([d]);
    expect([r, d].filter((c) => matchesFilter(c, "all", tabs))).toEqual([r, d]);
    expect(parseFilter("disputes")).toBe("disputes");
    expect(parseFilter("nonsense")).toBe("all");
    expect(parseFilter(null)).toBe("all");
  });

  it("streams messages in once, in the order spoken, and never loses them to a stale payload", () => {
    let reviews = [review({ status: "running", verdict: null, transcript: [msg("prosecutor", 10)] })];
    reviews = addReviewMessage(reviews, "rev_1", msg("defender", 20))!;
    reviews = addReviewMessage(reviews, "rev_1", msg("defender", 20))!;
    expect(reviews[0]!.transcript.map((m) => m.role)).toEqual(["prosecutor", "defender"]);
    reviews = upsertReview(reviews, review({ status: "running", verdict: null, transcript: [msg("prosecutor", 10)] }));
    expect(reviews[0]!.transcript).toHaveLength(2);
    expect(addReviewMessage(reviews, "rev_unknown", msg("judge", 30))).toBe(reviews);

    let disputes = [dispute()];
    disputes = addDisputeMessage(disputes, "PP-D-1", msg("prosecutor", 10), 5)!;
    expect(disputes[0]!.jury).toMatchObject({ status: "running", createdAt: 5 });
    disputes = upsertDispute(disputes, dispute({ jury: { status: "running", transcript: [], createdAt: 5 } }));
    expect(disputes[0]!.jury!.transcript).toHaveLength(1);
    // A re-run is a new hearing: its empty transcript replaces the old one.
    disputes = upsertDispute(disputes, dispute({ jury: { status: "running", transcript: [], createdAt: 99 } }));
    expect(disputes[0]!.jury!.transcript).toHaveLength(0);
  });

  it("labels verdicts, reasons, stages and outcomes in plain words", () => {
    expect(reviewOutcome({ status: "done", verdict: "freeze" })).toBe("frozen");
    expect(reviewOutcome({ status: "done", verdict: "void" })).toBe("voided");
    expect(reviewOutcome({ status: "failed", verdict: "escalate" })).toBe("human");
    expect(reviewOutcome({ status: "running", verdict: null })).toBe("hearing");
    expect(disputeReasonLabel("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toBe("Not as described");
    expect(disputeReasonLabel("UNAUTHORISED")).toBe("Unauthorized payment");
    expect(disputeReasonLabel("SOMETHING_NEW")).toBe("Something new");
    expect(disputeStageLabel("PRE_ARBITRATION")).toBe("Pre-arbitration");
    expect(disputeStageLabel(null)).toBeNull();
    expect(disputeBadge({ status: "RESOLVED", outcome: "RESOLVED_SELLER_FAVOUR" }).label).toBe("Charge upheld");
    expect(disputeBadge({ status: "RESOLVED", outcome: "RESOLVED_BUYER_FAVOUR" }).label).toBe("Refunded to the buyer");
    expect(disputeBadge({ status: "WAITING_FOR_SELLER_RESPONSE", outcome: null }).label).toBe("Awaiting response");
    expect(sentenceCase("RESOLVED_WITH_PAYOUT")).toBe("Resolved with payout");
    expect(confidencePct(0.916)).toBe(92);
    expect(confidencePct(null)).toBeNull();
    expect(juryModelLabel("gemma4:12b")).toBe("Gemma 4 · 12b");
    expect(juryModelLabel("mock")).toBe("LLM mock");
  });
});
