/**
 * Refunding a paid purchase (paypal-plan.md): Refund purchase, a confirm step with the amount (everything left by
 * default), then Refunded or Partly refunded. Each confirm carries one idempotency key, so a double click or a retry
 * after a dropped connection never refunds twice; changing the amount starts a new refund with a new key.
 */
import { MICROS_PER_CENT, type PurchaseDTO, type PurchaseRefundDTO } from "@p402/shared";
import { useState } from "react";
import { Button } from "../../components/Button";
import { describeError } from "../../components/ErrorState";
import { Input } from "../../components/Field";
import { Money } from "../../components/Money";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { formatCents, microsToInput, parseDollars } from "../../lib/format";

/** Refunds PayPal hasn't finished: they still count against what is left. */
const OPEN = new Set<PurchaseRefundDTO["status"]>(["processing", "pending", "unknown"]);

interface Confirm {
  key: string;
  amount: string;
}

export function PurchaseRefund({ purchase, onUpdate }: { purchase: PurchaseDTO; onUpdate: (purchase: PurchaseDTO) => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  /** The key of a refund PayPal hasn't confirmed, so "Check again" asks about the same refund. */
  const [unconfirmed, setUnconfirmed] = useState<{ key: string; amountCents: number } | null>(null);

  const refunds = purchase.refunds ?? [];
  const refunded = purchase.refundedCents ?? 0;
  const open = refunds.filter((r) => OPEN.has(r.status));
  const left = purchase.amountCents - refunded - open.reduce((sum, r) => sum + r.amountCents, 0);

  const micros = confirm ? parseDollars(confirm.amount) : null;
  const cents = micros != null && micros % MICROS_PER_CENT === 0 ? micros / MICROS_PER_CENT : null;
  const valid = cents != null && cents >= 1 && cents <= left;

  async function send(key: string, amountCents: number) {
    setBusy(true);
    try {
      const { purchase: updated, refund } = await api.purchases.refund(purchase.id, { amountCents, idempotencyKey: key });
      onUpdate(updated);
      setConfirm(null);
      if (refund.status === "unknown" || refund.status === "processing") {
        setUnconfirmed({ key, amountCents });
        toast({ tone: "warning", title: "PayPal hasn't confirmed the refund yet", description: "Check again in a moment. It can't refund twice." });
      } else {
        setUnconfirmed(null);
        toast({
          tone: "success",
          title: refund.status === "pending" ? "Refund on its way" : "Refunded",
          description: `${formatCents(refund.amountCents)} back to the buyer's PayPal account.`,
        });
      }
    } catch (err) {
      // The confirm step keeps its key: trying again can't refund twice.
      toast({ tone: "danger", ...describeError(err, "Couldn't refund the purchase") });
    } finally {
      setBusy(false);
    }
  }

  const summary =
    refunded >= purchase.amountCents ? (
      <>
        Refunded in full through PayPal: <Money cents={refunded} />
      </>
    ) : refunded > 0 ? (
      <>
        Refunded <Money cents={refunded} /> of <Money cents={purchase.amountCents} /> through PayPal
      </>
    ) : (
      "Purchased through PayPal"
    );

  return (
    <div className="cs-refund">
      <p className="cs-purchase-done" data-refunded={refunded > 0 || undefined}>
        {summary}
        {purchase.paypalOrderId ? <span className="mono muted"> · order {purchase.paypalOrderId}</span> : null}
      </p>
      {open.length ? (
        <p className="cs-note muted">
          <Money cents={open.reduce((sum, r) => sum + r.amountCents, 0)} /> waiting on PayPal to confirm.
          {unconfirmed ? (
            <>
              {" "}
              <Button size="sm" variant="ghost" loading={busy} onClick={() => void send(unconfirmed.key, unconfirmed.amountCents)}>
                Check again
              </Button>
            </>
          ) : null}
        </p>
      ) : null}

      {confirm ? (
        <form
          className="cs-refund-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && cents != null) void send(confirm.key, cents);
          }}
        >
          <Input
            label="Refund to the buyer"
            prefix="$"
            mono
            inputMode="decimal"
            autoFocus
            value={confirm.amount}
            onChange={(e) => setConfirm({ key: crypto.randomUUID(), amount: e.target.value })}
            hint={`Up to ${formatCents(left)}, back to the PayPal account that paid`}
            error={confirm.amount.trim() && !valid ? `Enter an amount from $0.01 to ${formatCents(left)}.` : undefined}
          />
          <div className="cs-refund-buttons">
            <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!valid}>
              {valid && cents != null ? `Refund ${formatCents(cents)}` : "Refund"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              Keep it
            </Button>
          </div>
        </form>
      ) : left > 0 ? (
        <Button size="sm" variant="secondary" onClick={() => setConfirm({ key: crypto.randomUUID(), amount: microsToInput(left * MICROS_PER_CENT) })}>
          {refunded > 0 || open.length ? "Refund the rest" : "Refund purchase"}
        </Button>
      ) : null}
    </div>
  );
}
