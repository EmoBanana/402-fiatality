/**
 * A selected tab (?tab=<id>): the review banner when paused, steps 1-6 with the live state of each, and the
 * tab card plus the company's other tabs on the side.
 */
import type { SettlementDTO, TabDetailDTO } from "@p402/shared";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { buttonClassName, Button } from "../../components/Button";
import { IconPlus } from "../../components/Icons";
import { PageHeader } from "../../components/PageHeader";
import { Callout } from "../../components/Callout";
import { EmptyState } from "../../components/EmptyState";
import { ErrorState } from "../../components/ErrorState";
import { IconExternal } from "../../components/Icons";
import { Money } from "../../components/Money";
import { Skeleton, SkeletonText } from "../../components/Skeleton";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { ApiError } from "../../lib/api";
import { useGatewayNow } from "../../lib/clock";
import { useGatewayConfig } from "../../lib/config";
import { formatCents, formatUsd } from "../../lib/format";
import { openPaypalApproval } from "../../lib/paypal";
import { upsertById } from "../../lib/resource";
import { AgentPanel } from "./AgentPanel";
import { CloseTab } from "./CloseTab";
import { PurchaseCard } from "./PurchaseCard";
import { ReviewBanner } from "./ReviewBanner";
import { clearApproval, trackApproval, useApproval } from "./session";
import { type StepState, StepSection } from "./StepSection";
import { TabCard, until } from "./TabCard";
import { TabList } from "./TabList";
import { type TabLive, useTabLive } from "./useTabLive";

function HoldApproval({ tab, onRefresh }: { tab: TabDetailDTO; onRefresh: () => void }) {
  const approval = useApproval(tab.id);
  const config = useGatewayConfig().data;
  const url = approval?.url ?? tab.paypal.approveUrl ?? null;

  function open() {
    if (!url) return;
    // The URL is known, so the window opens straight from the click (no await before window.open).
    trackApproval("tab", tab.id, url, openPaypalApproval(url, config?.publicBaseUrl ?? location.origin));
  }

  if (approval?.phase === "waiting") {
    return (
      <div className="cs-hold-wait">
        <p className="cs-note">
          <Spinner size={14} label="Waiting for PayPal" /> Waiting for you to approve the <Money cents={tab.holdCents} /> hold in the PayPal window…
        </p>
        <div className="cs-row">
          <Button size="sm" onClick={open}>
            Reopen PayPal window
          </Button>
          <Button size="sm" variant="ghost" onClick={onRefresh}>
            I've approved it
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="cs-hold-wait">
      {approval?.phase === "blocked" && url ? (
        <Callout tone="warning" title="Your browser blocked the PayPal window">
          <a href={url} target="_blank" rel="noopener">
            Open PayPal approval <IconExternal size={12} />
          </a>{" "}
          in a new tab. This page updates as soon as PayPal confirms the hold.
        </Callout>
      ) : approval?.phase === "cancelled" ? (
        <Callout title="You cancelled at PayPal">No hold was placed. Approve again whenever you're ready.</Callout>
      ) : approval?.phase === "failed" ? (
        <Callout tone="danger" title="PayPal couldn't place the hold">
          {approval.message ?? "Try again, or open a new tab."}
        </Callout>
      ) : approval?.phase === "approved" ? (
        <p className="cs-note">
          <Spinner size={14} label="Confirming" /> Approved. Confirming the hold with PayPal…
        </p>
      ) : (
        <p className="cs-note">
          This tab opens once you approve a <Money cents={tab.holdCents} /> hold in PayPal. Nothing is charged until the tab closes.
        </p>
      )}
      {approval?.phase !== "approved" ? (
        <div className="cs-row">
          <Button variant="primary" onClick={open} disabled={!url}>
            Approve hold with PayPal
          </Button>
          {!url ? <span className="cs-note ui-error">This hold has no approval link. Open a new tab instead.</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function headline(tab: TabDetailDTO): string {
  const hold = formatCents(tab.holdCents);
  const settlement = [...tab.settlements].sort((a, b) => b.createdAt - a.createdAt)[0];
  switch (tab.status) {
    case "pending_approval":
      return `Waiting for PayPal to approve the ${hold} hold.`;
    case "active":
      return `Agents spend against a ${hold} PayPal hold. Every paid call lands below as it happens.`;
    case "paused":
      return "Spending is paused while an AI review looks at the last calls.";
    case "frozen":
      return "Frozen: this tab's agents can't spend any more. Close it to charge what was billable.";
    case "closing":
      return "Charging PayPal once for everything billable…";
    case "settled":
      return settlement ? `Settled with one PayPal charge of ${formatCents(settlement.chargedCents)}.` : "Settled with one PayPal charge.";
    case "failed":
      return "The PayPal charge failed. Nothing was captured; try closing again.";
    default:
      return "This tab is closed.";
  }
}

function NewTabLink() {
  return (
    <Link to="/console" className={buttonClassName({ variant: "secondary" })}>
      <IconPlus size={14} /> New tab
    </Link>
  );
}

function stepStates(tab: TabDetailDTO, live: TabLive): { agent: StepState; purchase: StepState; close: StepState } {
  const pending = tab.status === "pending_approval";
  const settled = tab.status === "settled";
  const latestRun = live.runs[0];
  const captured = live.purchases.some((p) => p.status === "captured");
  const proposed = live.purchases.some((p) => p.status === "proposed" || p.status === "awaiting_approval" || p.status === "cancelled");
  return {
    agent: pending ? "upcoming" : settled || (latestRun && latestRun.status !== "running") ? "done" : "current",
    purchase: captured ? "done" : proposed && !settled ? "current" : "upcoming",
    close: settled ? "done" : tab.status === "failed" || (!pending && latestRun && latestRun.status !== "running") ? "current" : "upcoming",
  };
}

export function TabWorkspace({ tabId }: { tabId: string }) {
  const live = useTabLive(tabId);
  const toast = useToast();
  const now = useGatewayNow(30_000);
  const approval = useApproval(tabId);
  const tab = live.tab;
  const status = tab?.status;

  // Celebrate the hold once, when the gateway (the source of truth) flips the tab to active.
  const previous = useRef(status);
  useEffect(() => {
    if (previous.current === "pending_approval" && status === "active" && tab) {
      toast({ tone: "success", title: "Hold approved", description: `${formatCents(tab.holdCents)} is on hold with PayPal. Agents can spend now.` });
      clearApproval(tabId);
    }
    previous.current = status;
  }, [status, tab, tabId, toast]);

  // The PayPal window reported back (or closed): ask the gateway where things stand.
  const phase = approval?.phase;
  const { reload } = live;
  useEffect(() => {
    if (phase === "approved" || phase === "closed" || phase === "cancelled" || phase === "failed") void reload();
    if (phase === "cancelled") toast({ title: "Hold not approved", description: "You cancelled at PayPal; nothing was placed." });
  }, [phase, reload, toast]);

  if (live.error && !tab) {
    const missing = live.error instanceof ApiError && live.error.status === 404;
    const body = missing ? (
      <EmptyState
        title="No tab with this id"
        description="It may belong to a different gateway database. Open a new tab, or pick one from the list."
        action={
          <Link to="/console" className={buttonClassName({ variant: "primary" })}>
            Open a new tab
          </Link>
        }
      />
    ) : (
      <ErrorState error={live.error} onRetry={live.reload} />
    );
    return (
      <>
        <PageHeader eyebrow="Buyer console" title="Tab" actions={<NewTabLink />} />
        {body}
      </>
    );
  }

  if (!tab) {
    return (
      <>
      <PageHeader eyebrow="Buyer console" title={<Skeleton width={280} height={28} />} actions={<NewTabLink />} />
      <div className="cs-layout" aria-busy="true">
        <div className="cs-steps">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="cs-step-skeleton">
              <Skeleton width={28} height={28} radius={999} />
              <div className="ui-stack" style={{ flex: 1 }}>
                <Skeleton width={160} height={16} />
                {n === 4 ? <Skeleton height={180} /> : <SkeletonText lines={1} />}
              </div>
            </div>
          ))}
        </div>
        <aside className="cs-aside">
          <div className="ui-card" style={{ padding: 24 }}>
            <SkeletonText lines={5} />
          </div>
        </aside>
      </div>
      </>
    );
  }

  const states = stepStates(tab, live);
  const pending = tab.status === "pending_approval";
  const warn = tab.alarms.find((a) => a.kind === "budget_threshold");
  const policy = tab.policy;

  return (
    <>
      <PageHeader
        eyebrow={`Buyer console · ${tab.companyName ?? tab.companyId}`}
        title={tab.label || "Untitled tab"}
        description={headline(tab)}
        actions={<NewTabLink />}
      />
      <ReviewBanner tab={tab} onChanged={live.reload} />
      {warn && (tab.status === "active" || tab.status === "paused") ? (
        <Callout tone="warning" title="Most of the hold is spent" className="cs-banner">
          {warn.message}
        </Callout>
      ) : null}
      <div className="cs-layout">
        <div className="cs-steps">
          <StepSection n={1} title="Company" state="done" compact aside={<span className="cs-step-value">{tab.companyName ?? tab.companyId}</span>} />
          <StepSection
            n={2}
            title="Budget"
            state="done"
            compact
            aside={
              <span className="cs-step-value">
                <Money cents={policy.holdCents} /> hold · up to {formatUsd(policy.perCallMaxMicros)} a call · {formatUsd(policy.dailyCapMicros)} a day
              </span>
            }
            description={tab.policyText ? <q className="cs-quote">{tab.policyText}</q> : undefined}
          />
          <StepSection
            n={3}
            title="Hold"
            state={pending ? "current" : "done"}
            compact={!pending}
            aside={
              !pending && tab.authorizedAt ? (
                <span className="cs-step-value">
                  Approved {until(tab.authorizedAt, now)} · <span className="mono">{tab.paypal.orderId}</span>
                </span>
              ) : undefined
            }
          >
            {pending ? <HoldApproval tab={tab} onRefresh={live.reload} /> : null}
          </StepSection>
          <StepSection n={4} title="Run an agent" state={states.agent} description="Each paid API call is an IOU signed against this tab; failures are voided before anyone pays.">
            <AgentPanel tab={tab} runs={live.runs} onRun={live.upsertRun} />
          </StepSection>
          <StepSection n={5} title="Approve the purchase" state={states.purchase} description="When research turns into a decision, the agent asks you to buy. You approve it in PayPal.">
            {live.purchases.length ? (
              <div className="ui-stack">
                {live.purchases.map((p) => (
                  <PurchaseCard key={p.id} purchase={p} onUpdate={live.upsertPurchase} />
                ))}
              </div>
            ) : (
              <p className="muted cs-note">No purchase proposed yet. A Gemma run ends with one when it finds something worth buying.</p>
            )}
          </StepSection>
          <StepSection n={6} title="Close the tab" state={states.close} description="One PayPal charge for everything billable. Sellers are paid weekly.">
            <CloseTab
              tab={tab}
              onSettled={(settlement: SettlementDTO) =>
                live.setTab((current) => ({ ...current, settlements: upsertById(current.settlements, settlement) }))
              }
            />
          </StepSection>
        </div>
        <aside className="cs-aside" aria-label="Tab details">
          <TabCard tab={tab} />
          <TabList companyId={tab.companyId} selectedId={tab.id} live={tab} title={`${tab.companyName ?? "Company"} tabs`} />
        </aside>
      </div>
    </>
  );
}
