/**
 * Bryntum Scheduler 8 showing every tab's hold → reauthorization → charge, the sellers' payouts, and a
 * "now" line that follows the gateway's (possibly fast-forwarded) demo clock.
 *
 * Only the planned charge is draggable (demo mode). A drop asks the parent to PATCH the schedule; the drop
 * is held open (`context.async`) and reverted if the gateway refuses.
 */
import { BryntumScheduler, type BryntumSchedulerProps } from "@bryntum/scheduler-react-enterprise";
import "@bryntum/core-enterprise/fontawesome/css/fontawesome.css";
import "@bryntum/core-enterprise/fontawesome/css/solid.css";
import "@bryntum/scheduler-enterprise/scheduler.css";
import "@bryntum/scheduler-enterprise/svalbard.css";
import { formatCents, type TabStatus } from "@p402/shared";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { TAB_STATUS_BADGE } from "../../components";
import { formatDateTime, formatUsd } from "../../lib/format";
import { ROW_HEIGHT, type TimelineEvent, type TimelineEventKind, type TimelineModel, type TimelineResource } from "./buildTimeline";
import { registerBryntumLicense } from "./license";
import "./timeline.css";

registerBryntumLicense();

/** Bryntum renders DomConfig objects; `text` is always set as text, never parsed as HTML. */
type Dom = { tag?: string; className?: string; text?: string; children?: Dom[]; style?: Record<string, string> };

interface RecordLike {
  get(field: string): unknown;
  id: string | number;
  name?: string;
  startDate?: Date;
}

type EventStyle = NonNullable<BryntumSchedulerProps["eventStyle"]>;

/** Planned windows are dashed; milestones are filled diamonds (planned ones are hollowed out in CSS). */
function styleFor(kind: TimelineEventKind, planned: boolean): EventStyle {
  if (kind === "honor" || kind === "honor2") return planned ? "dashed" : "tonal";
  return "filled";
}

/**
 * Two tracks per tab row: the honor windows above, the moments (reauthorization, charge) below, so labels
 * never collide. Payout milestones sit centered in their own row.
 */
const TRACK: Record<TimelineEventKind, { top: number; height: number }> = {
  honor: { top: 9, height: 20 },
  honor2: { top: 9, height: 20 },
  reauth: { top: 35, height: 16 },
  charge: { top: 35, height: 16 },
  requested: { top: 22, height: 16 },
  payout: { top: 22, height: 16 },
  nextPayout: { top: 22, height: 16 },
};

const RESOURCE_COLUMN_WIDTH = 248;
const DAY_MS = 86_400_000;

/** Week over day headers; `tickWidth` (px per day) is computed so the whole range fits the width. */
function preset(tickWidth: number): BryntumSchedulerProps["viewPreset"] {
  return {
    base: "weekAndDay",
    tickWidth,
    displayDateFormat: "MMM D, HH:mm",
    timeResolution: { unit: "hour", increment: 1 },
    headers: [
      { unit: "week", dateFormat: "MMM D" },
      { unit: "day", dateFormat: "D" },
    ],
  };
}

/** Milestones whose name lives only in the tooltip (the legend names them; the charge label sits nearby). */
const UNLABELLED: ReadonlySet<TimelineEventKind> = new Set(["reauth"]);

export interface DropRequest {
  tabId: string;
  closeAt: number;
}

export interface TabSchedulerProps {
  model: TimelineModel;
  now: number;
  demo: boolean;
  /** Validate a charge drop: null when fine, else the reason shown in the drag tooltip. */
  validateDrop: (tabId: string, at: number) => string | null;
  /** Persist a charge drop; reject to revert it. */
  onDrop: (request: DropRequest) => Promise<void>;
  height: number;
}

function statusTone(status: TabStatus | null): string {
  return status ? TAB_STATUS_BADGE[status].tone : "neutral";
}

function resourceCell(record: RecordLike): Dom {
  const kind = record.get("kind") as TimelineResource["kind"];
  const name = String(record.get("name") ?? "");
  if (kind === "payouts") {
    return {
      className: "p402-res",
      children: [
        { className: "p402-res-title", text: name },
        { className: "p402-res-meta", children: [{ tag: "span", text: "Weekly, to sellers owed $10+" }] },
      ],
    };
  }
  const status = (record.get("status") as TabStatus | null) ?? null;
  const badge = status ? TAB_STATUS_BADGE[status] : null;
  const billable = Number(record.get("billableMicros") ?? 0);
  const hold = Number(record.get("holdCents") ?? 0);
  const small = Boolean(record.get("small"));
  return {
    className: "p402-res",
    children: [
      { className: "p402-res-title", text: name },
      {
        className: "p402-res-meta",
        children: [
          { tag: "span", className: `p402-res-status p402-tone--${statusTone(status)}`, text: badge?.label ?? "" },
          { tag: "span", className: "p402-res-amount", text: `${formatUsd(billable)} of ${formatCents(hold)}` },
          ...(small ? [{ tag: "span", className: "p402-res-flag", text: "day 25/28" }] : []),
        ],
      },
    ],
  };
}

function tooltip(record: RecordLike): Dom {
  const detail = (record.get("detail") as string[] | undefined) ?? [];
  const planned = Boolean(record.get("planned"));
  return {
    className: "p402-tip",
    children: [
      {
        className: "p402-tip-head",
        children: [
          { tag: "span", className: "p402-tip-title", text: String(record.name ?? "") },
          ...(planned ? [{ tag: "span", className: "p402-tip-flag", text: "Planned" }] : []),
        ],
      },
      ...detail.map((line) => ({ className: "p402-tip-line", text: line })),
    ],
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

export function TabScheduler({ model, now, demo, validateDrop, onDrop, height }: TabSchedulerProps) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // Fit the whole range to the available width, at no less than 16 px a day (below that the axis scrolls).
  // Done here rather than with forceFit, which keeps a larger floor on narrow screens.
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry?.contentRect.width ?? 0)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const days = Math.max(1, Math.round((model.end.getTime() - model.start.getTime()) / DAY_MS));
  const tickWidth = width > 0 ? Math.max(16, (width - RESOURCE_COLUMN_WIDTH - 3) / days) : 24;
  const viewPreset = useMemo(() => preset(tickWidth), [tickWidth]);
  // Bryntum reads these callbacks once; keep the latest closures behind refs.
  const validateRef = useRef(validateDrop);
  validateRef.current = validateDrop;
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const config = useMemo<BryntumSchedulerProps>(
    () => ({
      rowHeight: ROW_HEIGHT,
      barMargin: 8,
      resourceMargin: 8,
      eventLayout: "none",
      milestoneLayoutMode: "estimate",
      milestoneTextPosition: "always-outside",
      milestoneCharWidth: 7,
      weekStartDay: 1,
      snap: true,
      // The tick width is computed from the container for exactly the model's range; don't let Bryntum re-fit
      // it or widen the range to whole weeks.
      suppressFit: true,
      autoAdjustTimeAxis: false,
      zoomOnMouseWheel: false,
      zoomOnTimeAxisDoubleClick: false,
      createEventOnDblClick: false,
      enableEventAnimations: false,
      useInitialAnimation: false,
      columnLines: true,
      emptyText: "No tabs yet",
      columns: [
        {
          text: "Tab",
          field: "name",
          width: RESOURCE_COLUMN_WIDTH,
          sortable: false,
          groupable: false,
          editor: false,
          cellCls: "p402-res-cell",
          renderer: ({ record }: { record: unknown }) => resourceCell(record as RecordLike),
        },
      ],
      eventRenderer: ({ eventRecord, renderData }) => {
        const record = eventRecord as unknown as RecordLike;
        const kind = record.get("kind") as TimelineEventKind;
        const planned = Boolean(record.get("planned"));
        const classes = ["p402-ev", `p402-ev--${kind}`, planned ? "p402-ev--planned" : "p402-ev--done"];
        if (Boolean(record.get("draggable"))) classes.push("p402-ev--draggable");
        const wrapper = renderData.wrapperCls;
        if (typeof wrapper === "string") renderData.wrapperCls = `${wrapper} ${classes.join(" ")}`;
        else for (const cls of classes) (wrapper as unknown as { add(c: string): void }).add(cls);
        renderData.eventStyle = styleFor(kind, planned);
        if (UNLABELLED.has(kind)) return "";
        return { tag: "span", className: "p402-ev-label", text: String(record.name ?? "") } as Dom;
      },
      // A real listener, not an onXxx prop: the scheduler only fires eventLayoutDone when hasListener() sees one.
      listeners: {
        eventLayoutDone: ({ eventsData }: { eventsData: Array<{ eventRecord: unknown; top: number; height: number }> }) => {
          for (const data of eventsData) {
            const track = TRACK[(data.eventRecord as RecordLike).get("kind") as TimelineEventKind];
            if (!track) continue;
            data.top = track.top;
            data.height = track.height;
          }
        },
      },
      // Interaction: tooltips everywhere, dragging only for the planned charge.
      eventTooltipFeature: {
        hoverDelay: 120,
        hideDelay: 80,
        maxWidth: 320,
        template: ({ eventRecord }: { eventRecord: unknown }) => tooltip(eventRecord as RecordLike),
      },
      eventDragFeature: {
        constrainDragToResource: true,
        showExactDropPosition: true,
        validatorFn: ({ eventRecords, startDate }: { eventRecords: unknown[]; startDate: Date }) => {
          const record = eventRecords[0] as RecordLike | undefined;
          const tabId = record ? String(record.get("tabId") ?? "") : "";
          if (!record || record.get("kind") !== "charge" || !tabId) return { valid: false, message: "Only the planned charge moves." };
          const problem = validateRef.current(tabId, startDate.getTime());
          return problem ? { valid: false, message: problem } : { valid: true };
        },
        tooltipTemplate: ({ startDate, valid }: { startDate: Date; valid: boolean }) =>
          `<div class="p402-drag-tip${valid ? "" : " p402-drag-tip--invalid"}"><strong>Charge</strong> ${escapeHtml(formatDateTime(startDate.getTime()))}</div>`,
      },
      onBeforeEventDropFinalize: ({ context }) => {
        const record = context.eventRecord as unknown as RecordLike;
        const tabId = String(record.get("tabId") ?? "");
        if (!context.valid || !tabId) return;
        context.async = true;
        dropRef.current({ tabId, closeAt: context.startDate.getTime() }).then(
          () => context.finalize(true),
          () => context.finalize(false),
        );
      },
      dependenciesFeature: false,
      dependencyEditFeature: false,
      eventDragCreateFeature: false,
      eventResizeFeature: false,
      eventEditFeature: false,
      eventMenuFeature: false,
      scheduleMenuFeature: false,
      cellMenuFeature: false,
      headerMenuFeature: false,
      timeAxisHeaderMenuFeature: false,
      scheduleTooltipFeature: false,
      cellEditFeature: false,
      eventCopyPasteFeature: false,
      columnReorderFeature: false,
      columnPickerFeature: false,
      sortFeature: false,
      stripeFeature: false,
      timeRangesFeature: { showHeaderElements: true, enableResizing: false, showCurrentTimeLine: false },
      resourceTimeRangesFeature: true,
    }),
    [],
  );

  const timeRanges = useMemo(() => [{ id: "now", name: "Now", startDate: new Date(now), cls: "p402-now" }], [now]);
  const resources = useMemo(() => model.resources.map((r) => ({ ...r })), [model.resources]);
  const events = useMemo(() => model.events.map((e: TimelineEvent) => ({ ...e })), [model.events]);

  return (
    <div className="p402-timeline" style={{ height }} ref={container}>
      <BryntumScheduler
        {...config}
        viewPreset={viewPreset}
        readOnly={!demo}
        startDate={model.start}
        endDate={model.end}
        resources={resources}
        events={events}
        resourceTimeRanges={model.ranges}
        timeRanges={timeRanges}
      />
    </div>
  );
}
