/**
 * Clearing terminal (SPEC §9.2): every IOU as it clears, on AG Grid Enterprise. Stat strip, "Ask the ledger"
 * (AG Grid AI Toolkit), the live IOU grid, settlements and payouts tabs, and a rail with the seller pulse
 * sparklines, the live AI review debate and alarms. AG Grid is registered by features/terminal/agGrid, so it
 * only loads with this page's chunk.
 */
import "../features/terminal/agGrid";
import "../features/terminal/terminal.css";
import type { PayoutDTO, SettlementDTO } from "@p402/shared";
import type { GridApi } from "ag-grid-community";
import { exportMultipleSheetsAsExcel } from "ag-grid-enterprise";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Badge, Button, Callout, Card, PageHeader, useToast } from "../components";
import { OpenDisputesLink } from "../features/jury/OpenDisputesLink";
import { AskLedger } from "../features/terminal/AskLedger";
import { fileStamp } from "../features/terminal/exporting";
import { LedgerFeed } from "../features/terminal/feed";
import { PayoutsGrid } from "../features/terminal/PayoutsGrid";
import { ReviewPanel } from "../features/terminal/ReviewPanel";
import { SellerPulse } from "../features/terminal/SellerPulse";
import { SettlementsGrid } from "../features/terminal/SettlementsGrid";
import { StatStrip } from "../features/terminal/StatStrip";
import { TerminalContext, useFeed, useTerminal, type VoucherRow } from "../features/terminal/store";
import { VouchersGrid } from "../features/terminal/VouchersGrid";
import { type ConnectionStatus, useGatewayStatus, useOnReconnect } from "../lib/events";
import { formatCount } from "../lib/format";

type TabKey = "ious" | "settlements" | "payouts";

function LiveBadge({ status }: { status: ConnectionStatus }) {
  if (status === "open")
    return (
      <Badge tone="success" dot className="tx-live" title="Receiving gateway events">
        Live
      </Badge>
    );
  if (status === "connecting")
    return (
      <Badge tone="warning" dot title="Connecting to the gateway">
        Connecting
      </Badge>
    );
  return (
    <Badge dot title="Not receiving events">
      Offline
    </Badge>
  );
}

function ProblemNotice() {
  const feed = useFeed();
  const problem = useTerminal((s) => s.problem);
  const [busy, setBusy] = useState(false);
  if (!problem) return null;
  const title = problem.kind === "offline" ? "The gateway isn't running" : problem.kind === "not_wired" ? "The ledger isn't wired up yet" : "Couldn't load the ledger";
  return (
    <Callout
      tone={problem.kind === "error" ? "danger" : "warning"}
      title={title}
      role="alert"
      actions={
        <Button
          size="sm"
          loading={busy}
          onClick={() => {
            setBusy(true);
            void feed.load().finally(() => setBusy(false));
          }}
        >
          Retry
        </Button>
      }
    >
      {problem.kind === "offline" ? (
        <>
          Start it from the repo root with <code>npm run dev</code>.
        </>
      ) : (
        problem.message
      )}{" "}
      The terminal reconnects by itself and fills in as soon as the gateway answers.
    </Callout>
  );
}

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "ious", label: "IOUs" },
  { key: "settlements", label: "Settlements" },
  { key: "payouts", label: "Payouts" },
];

function Tabs({ tab, onChange }: { tab: TabKey; onChange: (tab: TabKey) => void }) {
  const ious = useTerminal((s) => s.voucherCount);
  const settlements = useTerminal((s) => s.settlements.length);
  const payouts = useTerminal((s) => s.payouts.length);
  const counts: Record<TabKey, number> = { ious, settlements, payouts };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = TABS.findIndex((t) => t.key === tab);
    const next = TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    onChange(next.key);
    document.getElementById(`tx-tab-${next.key}`)?.focus();
  };

  return (
    <div className="tx-tabs" role="tablist" aria-label="Ledger views" onKeyDown={onKeyDown}>
      {TABS.map((t) => (
        <button
          key={t.key}
          id={`tx-tab-${t.key}`}
          type="button"
          role="tab"
          className="tx-tab"
          aria-selected={tab === t.key}
          aria-controls={`tx-tabpanel-${t.key}`}
          tabIndex={tab === t.key ? 0 : -1}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          <span className="tx-tab-count">{formatCount(counts[t.key])}</span>
        </button>
      ))}
    </div>
  );
}

export default function Terminal() {
  const [feed] = useState(() => new LedgerFeed());
  const [vouchers, setVouchers] = useState<GridApi<VoucherRow> | null>(null);
  const settlementsApi = useRef<GridApi<SettlementDTO> | null>(null);
  const payoutsApi = useRef<GridApi<PayoutDTO> | null>(null);
  const [tab, setTab] = useState<TabKey>("ious");
  const status = useGatewayStatus();
  const toast = useToast();

  useEffect(() => feed.start(), [feed]);
  useOnReconnect(() => void feed.load());
  // useOnReconnect skips the very first connection; if the page loaded while the gateway was down, load now.
  useEffect(() => {
    if (status === "open" && feed.store.getState().problem?.kind === "offline") void feed.load();
  }, [status, feed]);

  const exportLedger = () => {
    const sheets = [
      vouchers?.getSheetDataForExcel({ sheetName: "IOUs" }),
      settlementsApi.current?.getSheetDataForExcel({ sheetName: "Settlements" }),
      payoutsApi.current?.getSheetDataForExcel({ sheetName: "Payouts" }),
    ].filter((sheet): sheet is string => typeof sheet === "string" && sheet.length > 0);
    if (sheets.length === 0) {
      toast({ title: "Nothing to export yet", tone: "warning" });
      return;
    }
    exportMultipleSheetsAsExcel({ data: sheets, fileName: `402-fiatality-ledger-${fileStamp()}.xlsx` });
  };

  return (
    <TerminalContext.Provider value={feed}>
      <div className="tx-page">
        <PageHeader
          title="Clearing terminal"
          description="Every IOU as it clears: signed per call, voided when the data is bad, settled in one PayPal charge."
          actions={
            <div className="tx-head-actions">
              <OpenDisputesLink />
              <LiveBadge status={status} />
              <Button size="sm" onClick={exportLedger} title="IOUs, settlements and payouts as one Excel workbook">
                Export ledger
              </Button>
            </div>
          }
        />
        <ProblemNotice />
        <StatStrip />
        <AskLedger grid={vouchers} onAsk={() => setTab("ious")} />
        <div className="tx-main">
          <section className="tx-board" aria-label="Ledger">
            <Tabs tab={tab} onChange={setTab} />
            <div className="tx-tabpanel" role="tabpanel" id="tx-tabpanel-ious" aria-labelledby="tx-tab-ious" hidden={tab !== "ious"}>
              <VouchersGrid feed={feed} onApi={setVouchers} />
            </div>
            <div
              className="tx-tabpanel"
              role="tabpanel"
              id="tx-tabpanel-settlements"
              aria-labelledby="tx-tab-settlements"
              hidden={tab !== "settlements"}
            >
              <SettlementsGrid onApi={(api) => (settlementsApi.current = api)} />
            </div>
            <div className="tx-tabpanel" role="tabpanel" id="tx-tabpanel-payouts" aria-labelledby="tx-tab-payouts" hidden={tab !== "payouts"}>
              <PayoutsGrid onApi={(api) => (payoutsApi.current = api)} />
            </div>
          </section>
          <aside className="tx-rail" aria-label="Sellers, reviews and alarms">
            <Card className="tx-panel" padding="none" title="Seller pulse" subtitle="Billable spend per minute, last hour">
              <SellerPulse />
            </Card>
            <ReviewPanel />
          </aside>
        </div>
      </div>
    </TerminalContext.Provider>
  );
}
