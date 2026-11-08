/**
 * End to end over real HTTP: a listening gateway (mock PayPal via the fake settlement, mock AI), the fake seller,
 * a WebSocket client, and an in-process agent that pays with x402 vouchers through fetch, the way @p402/agent does.
 */
import type { AddressInfo } from "node:net";
import type {
  AgentRunDTO,
  AgentStepDTO,
  CatalogEntryDTO,
  CompanyDTO,
  GatewayEvent,
  MetricsSummaryDTO,
  PaymentRequired,
  PolicyParseDTO,
  SettlementResponse,
  TabCreatedDTO,
  TabDetailDTO,
  VoucherDTO,
} from "@p402/shared";
import { decodeX402Header, encodeX402Header, randomNonce, requestHash, signVoucher } from "@p402/shared/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunAgent } from "../src/context";
import { createHarness, sleep, type Harness } from "./helpers";

function matches(pattern: string, path: string): boolean {
  const p = pattern.split("/");
  const s = path.split("?")[0]!.split("/");
  return p.length === s.length && p.every((seg, i) => seg.startsWith(":") || seg === s[i]);
}

/** A minimal x402 buyer: learns prices from the catalog, pays on the first request, resyncs on stale_sequence. */
const miniAgent: RunAgent = async (opts) => {
  const { runId, gatewayUrl, tabId, agentId, privateKey, signal, onStep, mode } = opts;
  let index = 0;
  let spent = 0;
  const step = (s: Omit<AgentStepDTO, "runId" | "index" | "at">) => onStep({ runId, index: index++, at: Date.now(), ...s });
  const catalog = (await (await fetch(`${gatewayUrl}/api/catalog`, { headers: opts.apiHeaders })).json()) as CatalogEntryDTO[];
  const channels = new Map<string, { seq: number; cum: number }>();

  async function pay(sellerId: string, method: "GET" | "POST", path: string, body?: string) {
    const endpoint = catalog.find((c) => c.sellerId === sellerId)!.endpoints.find((e) => e.method === method && matches(e.path, path))!;
    const price = endpoint.priceMicros;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ch = channels.get(sellerId) ?? { seq: 0, cum: 0 };
      const iat = Math.floor(Date.now() / 1000);
      const voucher = {
        v: 1 as const,
        tab: tabId,
        seller: sellerId,
        seq: ch.seq + 1,
        price: String(price),
        cumulative: String(ch.cum + price),
        reqHash: requestHash(method, path, body ?? ""),
        agent: agentId,
        task: opts.taskId,
        iat,
        exp: iat + 60,
        nonce: randomNonce(),
      };
      const header = encodeX402Header({
        x402Version: 2,
        resource: { url: `${gatewayUrl}/s/${sellerId}${path}` },
        accepted: { scheme: "batch-settlement", network: "paypal:mock", asset: "USD", amount: String(price), payTo: sellerId, maxTimeoutSeconds: 300, extra: {} },
        payload: signVoucher(voucher, privateKey),
      });
      const res = await fetch(`${gatewayUrl}/s/${sellerId}${path}`, {
        method,
        body,
        signal,
        headers: { "payment-signature": header, ...(body ? { "content-type": "application/json" } : {}) },
      });
      await res.arrayBuffer();
      if (res.status === 402) {
        const extra = decodeX402Header<PaymentRequired>(res.headers.get("payment-required"))!.accepts[0]!.extra;
        if (extra.reason === "stale_sequence") {
          channels.set(sellerId, { seq: extra.expectedSeq! - 1, cum: Number(extra.expectedCumulative) - price });
          continue;
        }
        return { status: 402, reason: extra.reason };
      }
      const payment = decodeX402Header<SettlementResponse>(res.headers.get("payment-response"))!;
      channels.set(sellerId, { seq: ch.seq + 1, cum: ch.cum + price });
      if (payment.status === "accepted") spent += price;
      step({
        kind: "paid_call",
        text: `${method} ${path}`,
        costMicros: price,
        cumulativeMicros: Number(payment.cumulative),
        sellerId,
        endpoint: path,
        status: payment.status,
        ...(payment.reason ? { voidReason: payment.reason } : {}),
      });
      return { status: res.status, payment };
    }
    return { status: 402, reason: "stale_sequence" };
  }

  if (mode === "runaway") {
    for (let i = 0; i < 60 && !signal?.aborted; i++) {
      const r = await pay("acme", "POST", "/v1/search", JSON.stringify({ query: "espresso machine" }));
      if (r.status !== 402) continue;
      if (r.reason === "tab_paused") {
        step({ kind: "paused", text: "Tab paused for review" });
        await sleep(30);
        continue;
      }
      step({ kind: "error", text: `Stopped: ${r.reason}` });
      return { status: "finished", summary: `stopped: ${r.reason}`, spentMicros: spent };
    }
    return { status: "finished", summary: "gave up", spentMicros: spent };
  }

  step({ kind: "thought", text: "Search first, then compare the top three." });
  await pay("acme", "POST", "/v1/search", JSON.stringify({ query: "quiet espresso machine", limit: 5 }));
  for (const id of ["p1", "p2", "p3"]) await pay("acme", "GET", `/v1/products/${id}`);
  await pay("acme", "GET", "/v1/q/500");
  await pay("acme", "GET", "/v1/q/products-empty");
  channels.delete("acme"); // lose local state: the gateway's stale_sequence answer resyncs us
  await pay("acme", "GET", "/v1/q/ok");
  step({ kind: "decision", text: "The Brevia 2 is quiet and under budget." });
  return { status: "finished", summary: "Recommend the Brevia 2", spentMicros: spent };
};

async function waitFor(condition: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await sleep(20);
  }
}

describe("end to end over HTTP (mock PayPal, mock AI)", () => {
  let h: Harness;
  let url = "";
  const events: GatewayEvent[] = [];
  let ws: WebSocket;

  const api = async <T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };

  async function openTab(name: string, policy: Record<string, unknown>) {
    const company = await api<CompanyDTO>("POST", "/api/companies", { name });
    const created = await api<TabCreatedDTO>("POST", "/api/tabs", { companyId: company.body.id, policy });
    expect(created.status).toBe(201);
    h.settlement.approve(created.body.tab.id); // the PayPal approval (paypal-builder's /paypal/return in the real app)
    return created.body.tab.id;
  }

  beforeAll(async () => {
    h = await createHarness({ runAgent: miniAgent, gatewayUrl: () => url, metricsIntervalMs: 50 });
    await h.app.listen({ port: 0, host: "127.0.0.1" });
    url = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    ws = new WebSocket(`${url.replace("http", "ws")}/ws`);
    ws.addEventListener("message", (m) => events.push(JSON.parse(String(m.data)) as GatewayEvent));
    await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  });

  afterAll(async () => {
    ws.close();
    await h.close();
  });

  it("company -> policy -> hold -> scripted agent, with live events and a consistent ledger", async () => {
    const parsed = await api<PolicyParseDTO>("POST", "/api/policy/parse", { text: "$50 hold, $25 a day, only acme" });
    expect(parsed.status).toBe(200);
    const tabId = await openTab("Northwind Research", parsed.body.policy as unknown as Record<string, unknown>);

    const run = await api<AgentRunDTO>("POST", "/api/agent/runs", { tabId, task: "Find a quiet espresso machine under $200", mode: "scripted" });
    expect(run.status).toBe(201);
    await waitFor(() => events.some((e) => e.type === "agent.finished" && e.data.id === run.body.id));
    await h.idle();

    const final = (await api<AgentRunDTO>("GET", `/api/agent/runs/${run.body.id}`)).body;
    expect(final).toMatchObject({ status: "finished", result: { summary: "Recommend the Brevia 2" } });
    expect(final.steps.map((s) => s.kind)).toEqual(["thought", ...Array(7).fill("paid_call"), "decision"]);

    const vouchers = (await api<VoucherDTO[]>("GET", `/api/vouchers?tabId=${tabId}`)).body.reverse();
    expect(vouchers.map((v) => v.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(vouchers.map((v) => v.voidReason ?? v.status)).toEqual(["accepted", "accepted", "accepted", "accepted", "upstream_5xx", "empty_result", "accepted"]);
    expect(vouchers.every((v) => v.taskId === run.body.id && v.agentId === run.body.agentId)).toBe(true);

    // Ledger invariants: running cumulative per channel, billable = accepted, nothing in flight.
    let running = 0;
    for (const v of vouchers) {
      running += v.priceMicros;
      expect(v.cumulativeMicros).toBe(running);
    }
    const accepted = vouchers.filter((v) => v.status === "accepted").reduce((s, v) => s + v.priceMicros, 0);
    const tab = (await api<TabDetailDTO>("GET", `/api/tabs/${tabId}`)).body;
    expect(tab.channels).toEqual([{ sellerId: "acme", lastSeq: 7, lastCumulativeMicros: running }]);
    expect(tab.totals).toMatchObject({ calls: 7, accepted: 5, voided: 2, billableMicros: accepted, voidedMicros: 2_000 });
    expect(final.spentMicros).toBe(accepted);
    expect(h.ctx.db.prepare("SELECT COUNT(*) AS n FROM vouchers WHERE status = 'pending'").get()).toEqual({ n: 0 });

    // The live feed saw every judged call and an up-to-date metrics snapshot.
    await waitFor(() => events.some((e) => e.type === "metrics" && e.data.calls === 7));
    expect(events.filter((e) => e.type === "voucher.accepted")).toHaveLength(5);
    expect(events.filter((e) => e.type === "voucher.voided")).toHaveLength(2);
    expect(events.filter((e) => e.type === "agent.step" && e.data.runId === run.body.id)).toHaveLength(9);
    const metrics = (await api<MetricsSummaryDTO>("GET", "/api/metrics/summary")).body;
    expect(metrics).toMatchObject({ calls: 7, accepted: 5, voided: 2, billableMicros: accepted });
  });

  it("runaway agent: repeat_request -> pause -> AI debate -> freeze; the agent stops on tab_frozen", async () => {
    const tabId = await openTab("Runaway Corp", { alarms: { repeatRequestThreshold: 4 } });
    const seen = events.length;
    const run = await api<AgentRunDTO>("POST", "/api/agent/runs", { tabId, task: "Keep searching", mode: "runaway" });
    await waitFor(() => events.some((e) => e.type === "agent.finished" && e.data.id === run.body.id));
    await h.idle();

    const tab = (await api<TabDetailDTO>("GET", `/api/tabs/${tabId}`)).body;
    expect(tab.status).toBe("frozen");
    expect(tab.alarms.map((a) => [a.kind, a.status])).toEqual([["repeat_request", "resolved"]]);
    expect(tab.reviews[0]).toMatchObject({ verdict: "freeze", fault: "agent", decidedBy: "ai" });
    expect(tab.reviews[0]!.transcript).toHaveLength(3);
    expect(tab.totals.accepted).toBeGreaterThanOrEqual(4);

    const final = (await api<AgentRunDTO>("GET", `/api/agent/runs/${run.body.id}`)).body;
    expect(final.result?.summary).toBe("stopped: tab_frozen");
    const types = events.slice(seen).map((e) => e.type);
    const order = ["alarm.raised", "review.started", "review.message", "review.finished"].map((t) => types.indexOf(t as GatewayEvent["type"]));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h.ai.reviews.at(-1)?.task).toBe("Keep searching");
  });
});
