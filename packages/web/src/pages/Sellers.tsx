/**
 * Seller portal (SPEC §9.2): every listed API with its prices, balance, payouts and void rate; "List your
 * API"; weekly PayPal payouts and their history. Earnings from a charge under an open PayPal dispute are held
 * back from payouts until it resolves ("Held for disputes"). Kept live from `seller.updated` and
 * `payout.completed`. `/sellers?new=1` opens the listing form directly (the landing page links there).
 */
import type { SellerDTO } from "@p402/shared";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Drawer } from "../components/Drawer";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { IconPlus } from "../components/Icons";
import { Money } from "../components/Money";
import { PageHeader } from "../components/PageHeader";
import { Skeleton, SkeletonText } from "../components/Skeleton";
import { Stat } from "../components/Stat";
import { useToast } from "../components/Toast";
import { LIST_API_FORM_ID, ListApiForm } from "../features/sellers/ListApiForm";
import { Payouts } from "../features/sellers/Payouts";
import { SellerCard } from "../features/sellers/SellerCard";
import "../features/sellers/sellers.css";
import { api, isGatewayDown } from "../lib/api";
import { useGatewayEvents, useOnReconnect } from "../lib/events";
import { formatCount, formatPct } from "../lib/format";
import { upsertById, useResource } from "../lib/resource";

export default function Sellers() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const sellers = useResource((signal) => api.sellers.list(signal), []);
  const [thresholdCents, setThresholdCents] = useState(1000);
  const [saving, setSaving] = useState(false);
  const formOpen = params.get("new") === "1";

  useGatewayEvents("seller.updated", (event) => sellers.setData((list) => upsertById(list, event.data, true)));
  useOnReconnect(() => void sellers.reload());

  const openForm = () => setParams({ new: "1" });
  const closeForm = () => setParams({}, { replace: true });

  const onCreated = (seller: SellerDTO) => {
    sellers.setData((list) => upsertById(list, seller, true));
    closeForm();
    toast({ tone: "success", title: `${seller.name} is listed`, description: `Agents can pay at /s/${seller.id}.` });
  };

  const list = sellers.data ?? [];
  const totals = list.reduce(
    (acc, s) => ({
      owed: acc.owed + s.balanceMicros,
      paid: acc.paid + s.paidOutMicros,
      calls: acc.calls + s.stats.calls,
      voids: acc.voids + s.stats.voids,
      gross: acc.gross + s.stats.grossMicros,
      held: acc.held + (s.heldMicros ?? 0),
      holding: acc.holding + ((s.heldMicros ?? 0) > 0 ? 1 : 0),
    }),
    { owed: 0, paid: 0, calls: 0, voids: 0, gross: 0, held: 0, holding: 0 },
  );

  return (
    <div className="sl">
      <PageHeader
        eyebrow="Seller portal"
        title="Sellers"
        description="APIs that agents pay per call. Sellers set their prices, keep about 95% after PayPal's fee, and are paid weekly through PayPal payouts."
        actions={
          <Button variant="primary" onClick={openForm}>
            <IconPlus size={14} /> List your API
          </Button>
        }
      />

      {sellers.error ? (
        <Card>
          <ErrorState error={sellers.error} onRetry={sellers.reload} />
        </Card>
      ) : (
        <>
          <Card className="sl-stats" aria-label="All sellers">
            {sellers.data ? (
              <>
                <Stat
                  label="Owed to sellers"
                  value={<Money micros={totals.owed} />}
                  // Below zero only when tabs closed at a few cents: PayPal's fixed fee share outweighed them.
                  hint={totals.owed < 0 ? "Fee shares outweighed tiny tabs" : "Settled, not yet paid out"}
                />
                <Stat label="Paid out" value={<Money micros={totals.paid} />} hint="Through PayPal payouts" />
                <Stat
                  label="Held for disputes"
                  value={<Money micros={totals.held} />}
                  hint={
                    totals.held > 0 ? (
                      <>
                        {totals.holding === 1 ? "1 seller" : `${formatCount(totals.holding)} sellers`} ·{" "}
                        <Link to="/jury?show=disputes">see the disputes</Link>
                      </>
                    ) : (
                      "Nothing held from payouts"
                    )
                  }
                />
                <Stat label="Earned from calls" value={<Money micros={totals.gross} />} hint={`${formatCount(totals.calls)} paid calls`} />
                <Stat
                  label="Voided"
                  value={totals.calls ? formatPct((totals.voids / totals.calls) * 100, 1) : "0%"}
                  hint={`${formatCount(totals.voids)} calls nobody paid for`}
                />
              </>
            ) : (
              Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="ui-stack" style={{ ["--stack-gap" as string]: "10px" }} aria-hidden="true">
                  <Skeleton width={90} height={12} />
                  <Skeleton width={120} height={22} />
                </div>
              ))
            )}
          </Card>

          <section className="sl-section" aria-labelledby="sl-listed">
            <div className="ui-section-head">
              <div>
                <h2 id="sl-listed">Listed APIs</h2>
                <p>Prices are per call. Voided calls are the ones each seller's own rules say aren't billable.</p>
              </div>
            </div>
            {!sellers.data ? (
              <div className="sl-grid-cards" aria-busy="true">
                {[0, 1].map((i) => (
                  <div key={i} className="ui-card" style={{ padding: 24 }}>
                    <SkeletonText lines={6} />
                  </div>
                ))}
              </div>
            ) : list.length === 0 ? (
              <Card>
                <EmptyState
                  title="No APIs listed yet"
                  description="List one to let agents pay for it per call. In demo mode the gateway seeds three."
                  action={
                    <Button variant="primary" onClick={openForm}>
                      List your API
                    </Button>
                  }
                />
              </Card>
            ) : (
              <div className="sl-grid-cards">
                {list.map((seller) => (
                  <SellerCard key={seller.id} seller={seller} thresholdCents={thresholdCents} onUpdate={(s) => sellers.setData((l) => upsertById(l, s, true))} />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {isGatewayDown(sellers.error) ? null : (
        <Payouts thresholdCents={thresholdCents} onThresholdChange={setThresholdCents} onPaid={() => void sellers.reload()} />
      )}

      <Drawer
        open={formOpen}
        onClose={closeForm}
        title="List your API"
        width={640}
        footer={
          <>
            <Button variant="ghost" onClick={closeForm}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={LIST_API_FORM_ID} loading={saving}>
              List API
            </Button>
          </>
        }
      >
        <ListApiForm onCreated={onCreated} onBusyChange={setSaving} />
      </Drawer>
    </div>
  );
}
