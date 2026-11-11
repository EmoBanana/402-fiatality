/**
 * Weekly PayPal payouts: run a batch now (the demo may lower the $10 threshold) and the history, with each
 * batch's items in a drawer. Kept live from `payout.completed`.
 */
import type { PayoutDTO } from "@p402/shared";
import { useState } from "react";
import { PayoutStatusBadge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Drawer } from "../../components/Drawer";
import { EmptyState } from "../../components/EmptyState";
import { describeError, ErrorState } from "../../components/ErrorState";
import { Select } from "../../components/Field";
import { Money } from "../../components/Money";
import { Skeleton } from "../../components/Skeleton";
import { Table } from "../../components/Table";
import { useToast } from "../../components/Toast";
import { api } from "../../lib/api";
import { useGatewayConfig } from "../../lib/config";
import { useGatewayEvents } from "../../lib/events";
import { formatCents, formatDateTime, plural } from "../../lib/format";
import { upsertById, useResource } from "../../lib/resource";

const THRESHOLDS = [
  { cents: 1000, label: "$10.00 (weekly rule)" },
  { cents: 100, label: "$1.00" },
  { cents: 10, label: "$0.10" },
];

export function Payouts({ thresholdCents, onThresholdChange, onPaid }: { thresholdCents: number; onThresholdChange: (cents: number) => void; onPaid: () => void }) {
  const toast = useToast();
  const demo = useGatewayConfig().data?.demo ?? false;
  const payouts = useResource((signal) => api.payouts.list(signal), []);
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState<PayoutDTO | null>(null);

  useGatewayEvents("payout.completed", (event) => payouts.setData((list) => upsertById(list, event.data)));

  async function run() {
    setRunning(true);
    try {
      const result = await api.payouts.run({ thresholdCents });
      if (result.payout) {
        payouts.setData((list) => upsertById(list, result.payout!));
        toast({
          tone: "success",
          title: `Paid ${plural(result.payout.items.length, "seller")} ${formatCents(result.payout.totalCents)}`,
          description: result.message,
        });
        onPaid();
      } else {
        toast({ title: "Nobody is owed enough yet", description: result.message });
      }
    } catch (err) {
      toast({ tone: "danger", ...describeError(err, "Couldn't run payouts") });
    } finally {
      setRunning(false);
    }
  }

  const list = [...(payouts.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <section className="sl-section" aria-labelledby="sl-payouts">
      <div className="ui-section-head">
        <div>
          <h2 id="sl-payouts">Payouts</h2>
          <p>Sellers are paid weekly through PayPal once they're owed {formatCents(1000)}. PayPal's {formatCents(25)} payout fee comes out of each payment.</p>
        </div>
        <div className="sl-payout-run">
          {demo ? (
            <Select label="Pay sellers owed at least" value={String(thresholdCents)} onChange={(e) => onThresholdChange(Number(e.target.value))}>
              {THRESHOLDS.map((t) => (
                <option key={t.cents} value={t.cents}>
                  {t.label}
                </option>
              ))}
            </Select>
          ) : null}
          <Button variant="secondary" onClick={run} loading={running}>
            Run payouts
          </Button>
        </div>
      </div>

      <Card padding="none">
        {payouts.error ? (
          <ErrorState error={payouts.error} onRetry={payouts.reload} compact />
        ) : !payouts.data ? (
          <div className="sl-table-skeleton" aria-busy="true">
            <Skeleton height={16} />
            <Skeleton height={16} />
            <Skeleton height={16} width="70%" />
          </div>
        ) : (
          <Table
            caption="Payout history"
            rows={list}
            rowKey={(p) => p.id}
            onRowClick={setOpen}
            rowLabel={(p) => `Open payout of ${formatCents(p.totalCents)} on ${formatDateTime(p.createdAt)}`}
            empty={<EmptyState title="No payouts yet" description="Run payouts once sellers are owed money. Each run is one PayPal batch." />}
            columns={[
              { key: "date", header: "Date", render: (p) => formatDateTime(p.createdAt) },
              { key: "batch", header: "PayPal batch", render: (p) => <span className="mono">{p.paypalBatchId ?? "pending"}</span> },
              {
                key: "sellers",
                header: "Sellers",
                render: (p) => (
                  <span className="sl-payout-sellers">{p.items.map((i) => i.sellerName ?? i.sellerId).join(", ") || "None"}</span>
                ),
              },
              { key: "total", header: "Paid", align: "right", render: (p) => <Money cents={p.totalCents} /> },
              { key: "fees", header: "PayPal fees", align: "right", render: (p) => <Money cents={p.feeCents} /> },
              { key: "status", header: "Status", align: "right", render: (p) => <PayoutStatusBadge status={p.status} /> },
            ]}
          />
        )}
      </Card>

      <Drawer open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `Payout of ${formatCents(open.totalCents)}` : "Payout"} width={560}>
        {open ? (
          <div className="ui-stack" style={{ ["--stack-gap" as string]: "24px" }}>
            <p className="muted">
              {formatDateTime(open.createdAt)} · PayPal batch <span className="mono">{open.paypalBatchId ?? "pending"}</span>
            </p>
            {open.error ? <p className="ui-error">{open.error}</p> : null}
            <Table
              rows={open.items}
              rowKey={(i) => i.sellerId}
              columns={[
                { key: "seller", header: "Seller", render: (i) => i.sellerName ?? i.sellerId },
                { key: "amount", header: "Paid", align: "right", render: (i) => <Money cents={i.amountCents} /> },
                { key: "fee", header: "Fee", align: "right", render: (i) => <Money cents={i.feeCents} /> },
                { key: "status", header: "PayPal status", align: "right", render: (i) => <span className="mono">{i.status}</span> },
              ]}
              footer={{
                seller: "Total",
                amount: <Money cents={open.totalCents} />,
                fee: <Money cents={open.feeCents} />,
              }}
              footerVariant="grand"
            />
          </div>
        ) : null}
      </Drawer>
    </section>
  );
}
