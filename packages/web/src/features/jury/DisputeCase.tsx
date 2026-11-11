/**
 * A PayPal dispute on a tab's one charge: PayPal's facts (reason, amount, status and stage, the response
 * deadline, what is held from sellers, the outcome), the jury's recommendation and debate, and the response
 * to send: evidence, a refund offer or accepting the claim, each behind a confirm step. In demo mode
 * (sandbox or mock) the dispute can also be ruled on by hand, clearly labelled as a simulation.
 */
import type { DisputeActionRequestDTO, DisputeDTO, TabDTO } from "@p402/shared";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Debate, DISPUTE_ROLES } from "../../components/Debate";
import { type DescriptionItem, DescriptionList } from "../../components/DescriptionList";
import { describeError } from "../../components/ErrorState";
import { Input, Textarea } from "../../components/Field";
import { Money } from "../../components/Money";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { useGatewayNow } from "../../lib/clock";
import { useGatewayConfig } from "../../lib/config";
import { formatCents, formatDateTime, formatRelative, microsToInput, parseDollars } from "../../lib/format";
import { ACTION_LABEL, disputeOutcome, disputeReasonLabel, disputeStageLabel, disputeStatusLabel, juryModelLabel, RECOMMENDATION } from "./docket";
import { CaseLinks, Confidence, Ruling } from "./parts";
import { isDispute } from "./useDocket";

type ActionKind = DisputeActionRequestDTO["kind"];

const CONFIRM: Record<ActionKind, { button: string; done: string }> = {
  send_evidence: { button: "Send evidence", done: "Evidence sent to PayPal" },
  make_offer: { button: "Send offer", done: "Refund offered" },
  accept_claim: { button: "Accept claim", done: "Claim accepted" },
};

function Fact({ term, children, hint, tone, title }: { term: string; children: ReactNode; hint?: ReactNode; tone?: "warning" | "danger"; title?: string }) {
  return (
    <div className="jy-fact" data-tone={tone}>
      <dt>{term}</dt>
      <dd title={title}>{children}</dd>
      {hint != null ? <dd className="jy-fact-hint">{hint}</dd> : null}
    </div>
  );
}

function ActionLog({ dispute }: { dispute: DisputeDTO }) {
  if (dispute.actions.length === 0) return null;
  const actions = [...dispute.actions].sort((a, b) => a.at - b.at);
  return (
    <section aria-label="Sent to PayPal">
      <p className="jy-label">Sent to PayPal</p>
      <ol className="jy-log">
        {actions.map((action, i) => (
          <li key={`${action.kind}-${action.at}-${i}`} data-ok={action.ok}>
            <p className="jy-log-head">
              <span>
                {ACTION_LABEL[action.kind] ?? action.kind}
                {action.amountCents != null ? (
                  <>
                    {" "}
                    · <Money cents={action.amountCents} />
                  </>
                ) : null}
              </span>
              <time className="muted">{formatDateTime(action.at)}</time>
            </p>
            {action.note ? <p className="jy-log-note">{action.note}</p> : null}
            {!action.ok ? <p className="jy-log-error">PayPal refused it{action.error ? `: ${action.error}` : "."}</p> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Simulation({ dispute, onUpdate }: { dispute: DisputeDTO; onUpdate: (d: DisputeDTO) => void }) {
  const toast = useToast();
  const config = useGatewayConfig().data;
  const [busy, setBusy] = useState<"buyer" | "seller" | null>(null);
  if (!config?.demo || (config.paypalMode !== "sandbox" && config.paypalMode !== "mock")) return null;
  // Once the seller accepts the claim, PayPal refunds the buyer and closes the case without a ruling.
  if (dispute.actions.some((a) => a.kind === "accept_claim" && a.ok)) return null;

  async function rule(outcome: "buyer" | "seller") {
    setBusy(outcome);
    try {
      const result = await api.disputes.adjudicate(dispute.id, { outcome });
      if (isDispute(result)) onUpdate(result);
      // On an inquiry the sandbox can't rule yet: the gateway escalated it to a claim instead.
      if (isDispute(result) && result.status !== "RESOLVED" && result.actions.at(-1)?.kind === "escalate") {
        toast({
          tone: "info",
          title: "Escalated to a PayPal claim",
          description: "In a few minutes PayPal asks the seller to answer the claim. Send evidence again, then rule once PayPal is reviewing it.",
        });
      } else {
        toast({ tone: "success", title: outcome === "buyer" ? "Ruled for the buyer" : "Ruled for the seller" });
      }
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't settle the case") });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="jy-sim" aria-label="PayPal's ruling">
      <p className="jy-label">PayPal's ruling</p>
      <div className="ui-cluster">
        <Button size="sm" onClick={() => rule("buyer")} loading={busy === "buyer"} disabled={Boolean(busy)}>
          Rule for buyer
        </Button>
        <Button size="sm" onClick={() => rule("seller")} loading={busy === "seller"} disabled={Boolean(busy)}>
          Rule for seller
        </Button>
      </div>
    </section>
  );
}

function Respond({ dispute, onUpdate }: { dispute: DisputeDTO; onUpdate: (d: DisputeDTO) => void }) {
  const toast = useToast();
  const jury = dispute.jury;
  const juryDraft = jury?.draft ?? "";
  const [draft, setDraft] = useState(juryDraft);
  const [edited, setEdited] = useState(false);
  const [confirm, setConfirm] = useState<ActionKind | null>(null);
  const [busy, setBusy] = useState(false);
  const outstanding = Math.max(0, dispute.amountCents - dispute.refundedCents);
  const suggested = jury?.refundCents && jury.refundCents > 0 ? Math.min(jury.refundCents, outstanding) : Math.max(1, Math.round(outstanding / 2));
  const [offer, setOffer] = useState(() => microsToInput(suggested * 10_000));
  const [offerEdited, setOfferEdited] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const confirmId = useId();

  // Follow the jury's draft (a re-run writes a new one) until the person starts editing.
  useEffect(() => {
    if (!edited) setDraft(juryDraft);
  }, [juryDraft, edited]);
  useEffect(() => {
    if (!offerEdited) setOffer(microsToInput(suggested * 10_000));
  }, [suggested, offerEdited]);
  useEffect(() => {
    // Land on the confirming button so Enter confirms and Tab reaches Cancel.
    if (confirm) confirmRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [confirm]);

  const offerMicros = parseDollars(offer);
  const offerCents = offerMicros == null ? null : Math.round(offerMicros / 10_000);
  const offerValid = offerCents != null && offerCents >= 1 && offerCents <= outstanding;
  const note = draft.trim();
  const recommended = jury?.status === "done" ? jury.recommendation : null;
  // PayPal takes refund offers only while a dispute is still an inquiry.
  const canOffer = !dispute.stage || dispute.stage.toUpperCase() === "INQUIRY";
  // The jury's recommendation is the one primary action (evidence when it can't be sent as advised).
  const primary: ActionKind = recommended === "accept" ? "accept_claim" : recommended === "partial_refund" && canOffer ? "make_offer" : "send_evidence";

  async function send(kind: ActionKind) {
    setBusy(true);
    try {
      const body: DisputeActionRequestDTO = { kind, ...(note ? { note } : {}) };
      if (kind === "make_offer" && offerCents != null) body.amountCents = offerCents;
      const result = await api.disputes.act(dispute.id, body);
      if (isDispute(result)) onUpdate(result);
      setConfirm(null);
      toast({
        tone: "success",
        title: CONFIRM[kind].done,
        description: kind === "make_offer" && offerCents != null ? `${formatCents(offerCents)} offered to the buyer through PayPal.` : undefined,
      });
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "PayPal didn't take that response") });
    } finally {
      setBusy(false);
    }
  }

  const question: Record<ActionKind, ReactNode> = {
    send_evidence: (
      <>
        Send the response above to PayPal as evidence that the <Money cents={dispute.amountCents} /> charge stands?
      </>
    ),
    make_offer: <>Offer the buyer a partial refund? PayPal passes the offer on; the buyer can accept it or keep the dispute open.</>,
    accept_claim: (
      <>
        Accept the claim and refund <Money cents={outstanding} />? The refund comes back from the tab's sellers in proportion to what each earned.
      </>
    ),
  };

  return (
    <section className="jy-respond" aria-label="Respond to PayPal">
      <Textarea
        label="Response to PayPal"
        hint={
          edited && draft !== juryDraft && juryDraft ? (
            <button type="button" className="jy-textlink" onClick={() => setEdited(false)}>
              Use the jury's draft again
            </button>
          ) : juryDraft ? (
            "Drafted by the jury from the signed IOU ledger. Edit it before you send."
          ) : (
            "Explain why the charge stands, or what you're offering."
          )
        }
        rows={6}
        value={draft}
        onChange={(e) => {
          setEdited(true);
          setDraft(e.target.value);
        }}
        disabled={busy}
      />
      <div className="ui-cluster jy-respond-actions">
        <Button
          variant={primary === "send_evidence" ? "primary" : "secondary"}
          onClick={() => setConfirm("send_evidence")}
          disabled={busy || !note}
          title={note ? undefined : "Write the evidence first"}
          aria-expanded={confirm === "send_evidence"}
          aria-controls={confirmId}
        >
          Send evidence
        </Button>
        <Button
          variant={primary === "make_offer" ? "primary" : "secondary"}
          onClick={() => setConfirm("make_offer")}
          disabled={busy || outstanding < 1 || !canOffer}
          title={canOffer ? undefined : "PayPal takes refund offers only while a dispute is an inquiry"}
          aria-expanded={confirm === "make_offer"}
          aria-controls={confirmId}
        >
          Offer refund {formatCents(offerValid && offerCents != null ? offerCents : suggested)}
        </Button>
        <Button
          variant={primary === "accept_claim" ? "primary" : "secondary"}
          onClick={() => setConfirm("accept_claim")}
          disabled={busy}
          aria-expanded={confirm === "accept_claim"}
          aria-controls={confirmId}
        >
          Accept claim
        </Button>
      </div>
      <div ref={confirmRef} id={confirmId} className="jy-confirm" role="group" aria-label="Confirm" hidden={!confirm}>
        {confirm ? (
          <>
            <p>{question[confirm]}</p>
            {confirm === "make_offer" ? (
              <Input
                label="Refund to offer"
                prefix="$"
                mono
                inputMode="decimal"
                value={offer}
                onChange={(e) => {
                  setOfferEdited(true);
                  setOffer(e.target.value);
                }}
                error={offer && !offerValid ? `Between $0.01 and ${formatCents(outstanding)}` : undefined}
                hint={`Up to ${formatCents(outstanding)}${jury?.refundCents ? `; the jury suggested ${formatCents(jury.refundCents)}` : ""}`}
                className="jy-offer"
              />
            ) : null}
            <div className="ui-cluster">
              <Button
                variant="primary"
                size="sm"
                loading={busy}
                disabled={confirm === "make_offer" ? !offerValid : confirm === "send_evidence" ? !note : false}
                onClick={() => send(confirm)}
              >
                {confirm === "make_offer" && offerValid && offerCents != null ? `Offer ${formatCents(offerCents)}` : CONFIRM[confirm].button}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirm(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

export function DisputeCase({ dispute, tab, onUpdate }: { dispute: DisputeDTO; tab: TabDTO | undefined; onUpdate: (d: DisputeDTO) => void }) {
  const toast = useToast();
  const now = useGatewayNow(30_000);
  const [rehearing, setRehearing] = useState(false);
  const jury = dispute.jury;
  const running = jury?.status === "running";
  const resolved = dispute.status === "RESOLVED";
  const outcome = disputeOutcome(dispute.outcome);
  const stage = disputeStageLabel(dispute.stage);
  const due = dispute.sellerResponseDueAt;
  const overdue = Boolean(due && !resolved && due < now);
  const recommendation = jury?.recommendation ? RECOMMENDATION[jury.recommendation] : null;

  async function rehear() {
    setRehearing(true);
    try {
      const result = await api.disputes.rehear(dispute.id);
      if (isDispute(result)) onUpdate(result);
      toast({ title: "The jury is hearing the case again", description: "Its debate streams in below." });
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't call the jury") });
    } finally {
      setRehearing(false);
    }
  }

  const facts: DescriptionItem[] = [
    { term: "Company", detail: tab?.companyName ?? dispute.companyId ?? "Unknown" },
    { term: "Tab", detail: tab?.label || (dispute.tabId ? "Untitled tab" : "Not linked"), hint: dispute.tabId ? <span className="mono">{dispute.tabId}</span> : undefined },
    { term: "PayPal capture", detail: <span className="mono">{dispute.captureId ?? "Unknown"}</span> },
    { term: "Dispute", detail: <span className="mono">{dispute.id}</span>, hint: `Opened ${formatDateTime(dispute.createdAt)}` },
  ];

  return (
    <>
      <dl className="jy-factrow">
        <Fact term="Reason" title={`PayPal reason code ${dispute.reason}`}>
          {disputeReasonLabel(dispute.reason)}
        </Fact>
        <Fact term="Disputed">
          <Money cents={dispute.amountCents} />
        </Fact>
        <Fact term="Status" hint={stage ?? undefined}>
          {disputeStatusLabel(dispute.status)}
        </Fact>
        {resolved ? (
          <Fact term="Outcome" hint={dispute.refundedCents > 0 ? <>Refunded {formatCents(dispute.refundedCents)}</> : "Nothing refunded"}>
            {outcome?.label ?? "Resolved"}
          </Fact>
        ) : (
          <Fact term="Respond by" tone={overdue ? "danger" : undefined} hint={due ? (overdue ? `Overdue by ${formatRelative(due, now).replace(/ ago$/, "")}` : formatRelative(due, now)) : undefined}>
            {due ? formatDateTime(due) : "No deadline yet"}
          </Fact>
        )}
        <Fact term="Held from sellers" hint={dispute.heldMicros > 0 ? "Kept out of payouts until it resolves" : resolved ? "Released" : "Nothing held"}>
          <Money micros={dispute.heldMicros} />
        </Fact>
      </dl>

      {dispute.buyerMessage ? (
        <figure className="jy-buyer">
          <blockquote>{dispute.buyerMessage}</blockquote>
          <figcaption>The buyer, to PayPal</figcaption>
        </figure>
      ) : null}

      <Ruling
        label={running ? "The jury is deliberating" : resolved ? "The jury recommended" : "The jury recommends"}
        reason={running ? null : jury?.status === "failed" ? (jury.reason ?? "The jury couldn't agree on a recommendation.") : jury?.reason}
        pending={
          running
            ? "The prosecutor argues the buyer's side, the defender the signed IOU ledger. The judge then drafts a response."
            : "The jury hasn't heard this case yet."
        }
        meta={
          <>
            {recommendation && !running ? <Badge tone="accent">{recommendation.label}</Badge> : null}
            {jury?.status === "failed" ? <Badge tone="warning">No recommendation</Badge> : null}
            {running ? (
              <Badge tone="accent" dot>
                In session
              </Badge>
            ) : null}
            {jury?.refundCents && !running ? (
              <span>
                Refund <Money cents={jury.refundCents} />
              </span>
            ) : null}
            {!running ? <Confidence value={jury?.confidence} /> : null}
            {jury?.model ? <span className="muted">{juryModelLabel(jury.model)}</span> : null}
            {!resolved ? (
              <Button size="sm" variant="ghost" className="jy-rehear" onClick={rehear} loading={rehearing} disabled={running || rehearing}>
                {jury ? "Run the jury again" : "Ask the jury"}
              </Button>
            ) : null}
          </>
        }
      />

      <div className="jy-case-grid">
        <div className="jy-section">
          {jury && (jury.transcript.length || running) ? (
            <section aria-label="The debate" aria-live={running ? "polite" : undefined}>
              <h4 className="jy-label">The debate</h4>
              <Debate messages={jury.transcript} running={running} roles={DISPUTE_ROLES} />
            </section>
          ) : null}
          {resolved ? (
            <p className="jy-closed">
              PayPal closed this dispute: <strong>{outcome?.label ?? "Resolved"}</strong>.{" "}
              {dispute.refundedCents > 0 ? (
                <>
                  <Money cents={dispute.refundedCents} /> went back to the buyer, taken from the tab's sellers in proportion to what each earned.
                </>
              ) : (
                "Nothing was refunded."
              )}
            </p>
          ) : (
            <Respond key={jury?.createdAt ?? 0} dispute={dispute} onUpdate={onUpdate} />
          )}
        </div>
        <aside className="jy-facts" aria-label="The charge">
          <DescriptionList dense items={facts} />
          <CaseLinks tabId={dispute.tabId} />
          <ActionLog dispute={dispute} />
          {!resolved ? <Simulation dispute={dispute} onUpdate={onUpdate} /> : null}
        </aside>
      </div>
    </>
  );
}
