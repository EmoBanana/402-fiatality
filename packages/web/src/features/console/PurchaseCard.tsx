/**
 * Step 5: what the agent wants to buy, what the research cost, and a human approving the purchase through
 * PayPal checkout (a separate one-time payment, not part of the tab). `purchase.updated` confirms capture.
 */
import type { PurchaseDTO } from "@p402/shared";
import { useEffect, useState } from "react";
import { PurchaseStatusBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { describeError } from "../../components/ErrorState";
import { IconArrowRight, IconExternal } from "../../components/Icons";
import { Money } from "../../components/Money";
import { Spinner } from "../../components/Spinner";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { getGatewayConfig, useGatewayConfig } from "../../lib/config";
import { openPaypalApproval, preparePaypalPopup } from "../../lib/paypal";
import { clearApproval, trackApproval, useApproval } from "./session";

async function gatewayOrigin(): Promise<string> {
  return getGatewayConfig()
    .then((c) => c.publicBaseUrl)
    .catch(() => location.origin);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function PurchaseCard({ purchase, onUpdate }: { purchase: PurchaseDTO; onUpdate: (purchase: PurchaseDTO) => void }) {
  const toast = useToast();
  const approval = useApproval(purchase.id);
  const config = useGatewayConfig().data;
  const [busy, setBusy] = useState(false);
  const [imageOk, setImageOk] = useState(true);
  const captured = purchase.status === "captured";
  const host = hostOf(purchase.productUrl);

  useEffect(() => {
    if (captured) clearApproval(purchase.id);
  }, [captured, purchase.id]);

  async function approve() {
    const pending = preparePaypalPopup();
    setBusy(true);
    try {
      const checkout = await api.purchases.checkout(purchase.id);
      onUpdate(checkout.purchase);
      trackApproval("purchase", purchase.id, checkout.approveUrl, pending.open(checkout.approveUrl, await gatewayOrigin()));
    } catch (err) {
      pending.close();
      toast({ tone: "danger", ...describeError(err, "Couldn't start the PayPal checkout") });
    } finally {
      setBusy(false);
    }
  }

  function reopen(url: string) {
    // No await before window.open: Safari only allows popups straight from the click.
    trackApproval("purchase", purchase.id, url, openPaypalApproval(url, config?.publicBaseUrl ?? location.origin));
  }

  const phase = captured ? null : approval?.phase;
  const approveUrl = approval?.url ?? purchase.approveUrl ?? null;

  return (
    <article className="ui-card cs-purchase" data-status={purchase.status}>
      <div className="cs-purchase-main">
        {purchase.imageUrl && imageOk ? (
          <img className="cs-purchase-img" src={purchase.imageUrl} alt="" width={72} height={72} loading="lazy" onError={() => setImageOk(false)} />
        ) : null}
        <div className="cs-purchase-text">
          <p className="ui-eyebrow">The agent proposes</p>
          <h3 className="cs-purchase-title">{purchase.title}</h3>
          <p className="cs-purchase-merchant">
            {purchase.merchant ?? "Merchant"}
            {purchase.productUrl ? (
              <>
                {" · "}
                <a href={purchase.productUrl} target="_blank" rel="noreferrer noopener">
                  {host ?? "Product page"} <IconExternal size={12} />
                  <span className="visually-hidden"> (opens in a new tab)</span>
                </a>
              </>
            ) : null}
          </p>
        </div>
        <div className="cs-purchase-price">
          <PurchaseStatusBadge status={purchase.status} />
          <Money cents={purchase.amountCents} className="cs-purchase-amount" />
        </div>
      </div>

      <p className="cs-purchase-math">
        <span>
          <span className="muted">research</span> <Money micros={purchase.researchCostMicros} />
        </span>
        <IconArrowRight size={14} />
        <span>
          <span className="muted">purchase</span> <Money cents={purchase.amountCents} />
        </span>
      </p>
      {purchase.reasoning ? <p className="cs-purchase-reason">{purchase.reasoning}</p> : null}

      <div className="cs-purchase-actions">
        {captured ? (
          <p className="cs-purchase-done">
            Purchased through PayPal{purchase.paypalOrderId ? <span className="mono muted"> · order {purchase.paypalOrderId}</span> : null}
          </p>
        ) : phase === "waiting" ? (
          <>
            <span className="cs-note">
              <Spinner size={14} label="Waiting for PayPal" /> Waiting for you to approve in the PayPal window…
            </span>
            {approveUrl ? (
              <Button size="sm" variant="ghost" onClick={() => reopen(approveUrl)}>
                Reopen PayPal
              </Button>
            ) : null}
          </>
        ) : phase === "approved" ? (
          <span className="cs-note">
            <Spinner size={14} label="Confirming" /> Approved. Confirming the payment with PayPal…
          </span>
        ) : (
          <>
            <Button variant="primary" onClick={approve} loading={busy}>
              {phase === "closed" || phase === "cancelled" || purchase.status === "cancelled" ? "Try PayPal again" : "Approve purchase with PayPal"}
            </Button>
            <span className="cs-note muted">A separate one-time PayPal payment; it doesn't touch the tab.</span>
          </>
        )}
      </div>

      {phase === "blocked" && approveUrl ? (
        <Callout tone="warning" title="Your browser blocked the PayPal window">
          <a href={approveUrl} target="_blank" rel="noopener">
            Open PayPal checkout <IconExternal size={12} />
          </a>{" "}
          and come back here; this card updates when the payment goes through.
        </Callout>
      ) : phase === "cancelled" ? (
        <Callout tone="neutral" title="Cancelled at PayPal">
          Nothing was charged. You can try again.
        </Callout>
      ) : phase === "failed" ? (
        <Callout tone="danger" title="PayPal couldn't complete the payment">
          {approval?.message ?? "Nothing was charged. Try again."}
        </Callout>
      ) : null}
    </article>
  );
}
