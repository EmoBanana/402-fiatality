/**
 * Tabs → scheduler rows. Pure: no React, no Bryntum.
 *
 * Each authorized tab gets (SPEC §6.2–6.3):
 *   honor   PayPal's first 3-day honor window (day 0–3)
 *   reauth  the reauthorization: day 4, or day 25 for a small tab; planned until `reauthorizedAt`
 *   honor2  the fresh 3-day honor window that reauthorization buys; planned until it happens
 *   charge  the one PayPal capture at `closeAt` (planned) or `closedAt` (done); the only draggable event
 * plus a faint band for the authorization's 29-day life. A "Seller payouts" row carries the weekly payouts
 * and the next planned one. Everything a tab hasn't done yet is marked `planned`.
 */
import { formatCents, type PayoutDTO, type SettlementDTO, type TabDTO, type TabStatus } from "@p402/shared";
import { formatCount, formatDateTime, formatUsd, shortId } from "../../lib/format";

export const DAY = 86_400_000;
const HOUR = 3_600_000;
export const PAYOUTS_ROW = "payouts";
/** Scheduler row height (px): two tracks, windows above and moments below. */
export const ROW_HEIGHT = 60;
/** Rows shown at most (newest tabs win). */
export const MAX_TABS = 40;

export type TimelineEventKind = "requested" | "honor" | "reauth" | "honor2" | "charge" | "payout" | "nextPayout";

export interface TimelineEvent {
  id: string;
  resourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  kind: TimelineEventKind;
  planned: boolean;
  draggable: boolean;
  resizable: boolean;
  /** Tooltip lines (plain text). */
  detail: string[];
  tabId: string | null;
}

export interface TimelineResource {
  id: string;
  name: string;
  kind: "tab" | "payouts";
  status: TabStatus | null;
  /** Company, for tab rows. */
  company: string | null;
  billableMicros: number;
  holdCents: number;
  /** On the day-25/28 schedule. */
  small: boolean;
}

export interface TimelineRange {
  id: string;
  resourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  cls: string;
}

export interface TimelineModel {
  resources: TimelineResource[];
  events: TimelineEvent[];
  /** Per-tab background bands (authorization validity). */
  ranges: TimelineRange[];
  start: Date;
  end: Date;
  /** Tabs left out because of MAX_TABS. */
  hidden: number;
}

const OPEN: ReadonlySet<TabStatus> = new Set(["active", "paused", "frozen", "closing"]);

export function isOpen(tab: Pick<TabDTO, "status">): boolean {
  return OPEN.has(tab.status);
}

/** Whole days since the hold, for labels ("day 4"). */
function dayOf(at: number, authorizedAt: number): number {
  return Math.max(0, Math.round((at - authorizedAt) / DAY));
}

export function tabName(tab: Pick<TabDTO, "id" | "label" | "companyName">): string {
  return tab.label?.trim() || tab.companyName?.trim() || shortId(tab.id);
}

function floorDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function event(
  e: Omit<TimelineEvent, "startDate" | "endDate" | "draggable" | "resizable"> & { start: number; end?: number; draggable?: boolean },
): TimelineEvent {
  const { start, end, draggable = false, ...rest } = e;
  return { ...rest, startDate: new Date(start), endDate: new Date(end ?? start), draggable, resizable: false };
}

export interface BuildOptions {
  now: number;
  /** Demo mode: the planned charge can be dragged. */
  demo: boolean;
}

export function buildTimeline(
  tabs: readonly TabDTO[],
  payouts: readonly PayoutDTO[],
  settlements: readonly SettlementDTO[],
  { now, demo }: BuildOptions,
): TimelineModel {
  const charged = new Map<string, SettlementDTO>();
  for (const s of settlements) if (s.status === "completed") charged.set(s.tabId, s);

  const ordered = [...tabs]
    .filter((t) => t.status !== "cancelled" || t.authorizedAt)
    .sort((a, b) => (b.authorizedAt ?? b.createdAt) - (a.authorizedAt ?? a.createdAt));
  const shown = ordered.slice(0, MAX_TABS).reverse(); // oldest first, like a Gantt

  const resources: TimelineResource[] = [];
  const events: TimelineEvent[] = [];
  const ranges: TimelineRange[] = [];

  for (const tab of shown) {
    const name = tabName(tab);
    const policy = tab.policy;
    const a = tab.authorizedAt ?? null;
    const reauthAt = tab.reauthorizeAt ?? (a !== null ? a + 4 * DAY : null);
    const small = a !== null && reauthAt !== null && reauthAt - a > 10 * DAY;
    resources.push({
      id: tab.id,
      name,
      kind: "tab",
      status: tab.status,
      company: tab.companyName ?? null,
      billableMicros: tab.totals.billableMicros,
      holdCents: tab.holdCents,
      small,
    });

    if (a === null) {
      if (tab.status === "pending_approval") {
        events.push(
          event({
            id: `${tab.id}:requested`,
            resourceId: tab.id,
            tabId: tab.id,
            kind: "requested",
            planned: true,
            name: "Hold requested",
            start: tab.createdAt,
            detail: [`Requested ${formatDateTime(tab.createdAt)}`, "Waiting for approval on PayPal. Nothing is held yet."],
          }),
        );
      }
      continue;
    }

    const closedAt = tab.closedAt ?? null;
    const open = isOpen(tab);
    const stop = closedAt ?? Number.POSITIVE_INFINITY;

    // Authorization life: 29 days, or until the charge used it up.
    const authEnd = Math.min(tab.expiresAt ?? a + 29 * DAY, stop);
    ranges.push({
      id: `${tab.id}:auth`,
      resourceId: tab.id,
      name: "",
      startDate: new Date(a),
      endDate: new Date(authEnd),
      cls: "p402-auth",
    });

    // 1. First honor window, day 0–3.
    const honor1End = Math.min(a + 3 * DAY, stop);
    events.push(
      event({
        id: `${tab.id}:honor`,
        resourceId: tab.id,
        tabId: tab.id,
        kind: "honor",
        planned: false,
        name: "Day 0–3",
        start: a,
        end: honor1End,
        detail: [
          `Hold placed ${formatDateTime(a)} for ${formatCents(tab.holdCents)}`,
          "Honor window, day 0–3: PayPal honors the full hold.",
        ],
      }),
    );

    // 2. Reauthorization and the second honor window.
    if (tab.reauthorizedAt) {
      const r = tab.reauthorizedAt;
      const day = dayOf(r, a);
      events.push(
        event({
          id: `${tab.id}:reauth`,
          resourceId: tab.id,
          tabId: tab.id,
          kind: "reauth",
          planned: false,
          name: `Reauthorized · day ${day}`,
          start: r,
          detail: [`Reauthorized ${formatDateTime(r)}`, "A fresh 3-day honor window for the same hold."],
        }),
      );
      const honor2End = tab.honorUntil && tab.honorUntil > r ? tab.honorUntil : r + 3 * DAY;
      events.push(
        event({
          id: `${tab.id}:honor2`,
          resourceId: tab.id,
          tabId: tab.id,
          kind: "honor2",
          planned: false,
          name: `Day ${day}–${day + 3}`,
          start: r,
          end: Math.min(honor2End, stop),
          detail: [`Honor window, day ${day}–${day + 3}: honored again after reauthorization.`],
        }),
      );
    } else if (open && reauthAt !== null && reauthAt < (tab.closeAt ?? Number.POSITIVE_INFINITY)) {
      const day = dayOf(reauthAt, a);
      const smallSoFar = !small && tab.totals.billableMicros < policy.smallTabMinCents * 10_000;
      events.push(
        event({
          id: `${tab.id}:reauth`,
          resourceId: tab.id,
          tabId: tab.id,
          kind: "reauth",
          planned: true,
          name: `Reauthorize · day ${day}`,
          start: reauthAt,
          detail: [
            `Planned ${formatDateTime(reauthAt)}`,
            small
              ? `Small tab: under ${formatCents(policy.smallTabMinCents)} on day 4, so renewal moved to day ${day}.`
              : "Renews the hold for a fresh 3-day honor window.",
            ...(smallSoFar
              ? [`Under ${formatCents(policy.smallTabMinCents)} so far: if still under on day 4, this moves to day 25 and the charge to day 28.`]
              : []),
          ],
        }),
      );
      const honor2End = Math.min(reauthAt + 3 * DAY, tab.closeAt ?? Number.POSITIVE_INFINITY);
      if (honor2End > reauthAt) {
        events.push(
          event({
            id: `${tab.id}:honor2`,
            resourceId: tab.id,
            tabId: tab.id,
            kind: "honor2",
            planned: true,
            name: `Day ${day}–${day + 3}`,
            start: reauthAt,
            end: honor2End,
            detail: [`Honor window, day ${day}–${day + 3}, once reauthorized.`],
          }),
        );
      }
    }

    // 3. The one charge.
    const settlement = charged.get(tab.id);
    if (closedAt) {
      const cents = settlement?.chargedCents ?? Math.floor(tab.totals.billableMicros / 10_000);
      events.push(
        event({
          id: `${tab.id}:charge`,
          resourceId: tab.id,
          tabId: tab.id,
          kind: "charge",
          planned: false,
          name: `Charged ${formatCents(cents)} · day ${dayOf(closedAt, a)}`,
          start: closedAt,
          detail: [
            `One PayPal charge ${formatDateTime(closedAt)} · day ${dayOf(closedAt, a)}`,
            settlement
              ? `PayPal fee ${formatCents(settlement.paypalFeeCents)} · ${formatCount(settlement.callCount - settlement.voidCount)} paid calls`
              : `${formatCount(tab.totals.accepted)} paid calls`,
          ],
        }),
      );
    } else if (open && tab.closeAt) {
      const day = dayOf(tab.closeAt, a);
      events.push(
        event({
          id: `${tab.id}:charge`,
          resourceId: tab.id,
          tabId: tab.id,
          kind: "charge",
          planned: true,
          name: `Charge · day ${day}`,
          start: tab.closeAt,
          draggable: demo,
          detail: [
            `Planned ${formatDateTime(tab.closeAt)}`,
            `Billable so far ${formatUsd(tab.totals.billableMicros)}; closes early at ${formatCents(policy.closeAtCents)}.`,
            ...(demo ? ["Drag to reschedule (demo)."] : []),
          ],
        }),
      );
    }
  }

  // Seller payouts: done, plus the next weekly one.
  const sortedPayouts = [...payouts].sort((x, y) => x.createdAt - y.createdAt);
  if (shown.length > 0 || sortedPayouts.length > 0) {
    resources.push({ id: PAYOUTS_ROW, name: "Seller payouts", kind: "payouts", status: null, company: null, billableMicros: 0, holdCents: 0, small: false });
    for (const p of sortedPayouts) {
      events.push(
        event({
          id: `payout:${p.id}`,
          resourceId: PAYOUTS_ROW,
          tabId: null,
          kind: "payout",
          planned: p.status === "pending",
          name: `Paid ${formatCents(p.totalCents)}`,
          start: p.createdAt,
          detail: [
            `Payout ${formatDateTime(p.createdAt)} · ${p.status}`,
            `${p.items.length} ${p.items.length === 1 ? "seller" : "sellers"}, ${formatCents(p.feeCents)} in payout fees`,
          ],
        }),
      );
    }
    const last = sortedPayouts.at(-1)?.createdAt;
    let next = last !== undefined ? last + 7 * DAY : nextMonday(now);
    while (next < now) next += 7 * DAY;
    events.push(
      event({
        id: "payout:next",
        resourceId: PAYOUTS_ROW,
        tabId: null,
        kind: "nextPayout",
        planned: true,
        name: "Next weekly payout",
        start: next,
        detail: [`Planned ${formatDateTime(next)}`, "Sellers owed $10 or more are paid; $0.25 payout fee each."],
      }),
    );
  }

  // Visible window: a day before the first event to a few days after the last (room for milestone labels).
  let min = now;
  let max = now;
  for (const e of events) {
    min = Math.min(min, e.startDate.getTime());
    max = Math.max(max, e.endDate.getTime());
  }
  const start = floorDay(min - DAY);
  const end = floorDay(max + 6 * DAY);

  return { resources, events, ranges, start: new Date(start), end: new Date(end), hidden: Math.max(0, ordered.length - shown.length) };
}

function nextMonday(now: number): number {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  const add = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

/** Where a dragged charge may land: after now, within the authorization, after the hold. */
export function validateCharge(tab: TabDTO | undefined, at: number, now: number): string | null {
  if (!tab) return "Unknown tab.";
  if (!isOpen(tab)) return "This tab is already settled.";
  const a = tab.authorizedAt ?? now;
  if (at <= now) return "Pick a time after the demo clock's now.";
  if (at <= a) return "The charge must come after the hold.";
  const expires = tab.expiresAt ?? a + 29 * DAY;
  if (at > expires - HOUR) return `The authorization expires ${formatDateTime(expires)}.`;
  return null;
}
