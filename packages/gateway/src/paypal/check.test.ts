/** `npm run check:paypal`'s flow, run offline against the mock PayPal (the real run needs a human and the sandbox). */
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { PaypalClient } from "../context";
import { openDb } from "../db/db";
import { formatCheckTable, runPaypalCheck, type CheckDeps } from "./check";
import { PaypalError } from "./errors";
import { approveMockOrder, createMockPaypal, inspectMockAuthorization } from "./mock";
import type { TokenSource } from "./oauth";

const tokens = (scope = "openid https://uri.paypal.com/services/payments/payouts"): TokenSource => ({
  get: async () => ({ value: "token", expiresAt: Date.now() + 3_600_000, scope }),
  invalidate: () => {},
});

function setup(overrides: Partial<CheckDeps> = {}) {
  const db = openDb(":memory:");
  const paypal = createMockPaypal({ config: { publicBaseUrl: "http://localhost:4020" }, db, log: pino({ level: "silent" }) });
  const deps: CheckDeps = {
    paypal,
    tokens: tokens(),
    publicBaseUrl: "http://localhost:4020",
    payoutReceiver: "seller@example.com",
    waitForApproval: async (orderId) => approveMockOrder(db, orderId) !== null,
    runId: "test",
    sleep: async () => {},
    ...overrides,
  };
  return { db, paypal, deps };
}

describe("runPaypalCheck", () => {
  it("passes every step on a healthy account and reports partial capture enabled", async () => {
    const { deps } = setup();
    const seen: string[] = [];
    const report = await runPaypalCheck({ ...deps, onRow: (row) => seen.push(row.step) });
    expect(report.failed).toBe(0);
    expect(report.partialCapture).toBe("ENABLED");
    expect(report.rows.map((r) => [r.step, r.result])).toEqual([
      ["OAuth token", "PASS"],
      ["Payouts permission", "PASS"],
      ["Create AUTHORIZE order", "PASS"],
      ["Payer approval", "PASS"],
      ["Authorize", "PASS"],
      ["Partial capture (final_capture)", "PASS"],
      ["Fee from seller_receivable_breakdown", "PASS"],
      ["Rest of the hold released", "PASS"],
      ["Create payout batch", "PASS"],
      ["Payout status", "PASS"],
    ]);
    expect(seen).toHaveLength(report.rows.length);
    expect(report.rows.find((r) => r.step === "Rest of the hold released")?.detail).toContain("final_capture released the remaining $3.77");
    const table = formatCheckTable(report);
    expect(table).toContain("Partial capture: ENABLED");
    expect(table.split("\n")[0]).toMatch(/^Step\s+Result\s+debug_id\s+Detail$/);
  });

  it("detects a merchant without partial capture, shows the debug_id and releases the test hold", async () => {
    const { db, paypal, deps } = setup();
    let authId = "";
    const noPartial: PaypalClient = {
      ...paypal,
      mode: paypal.mode,
      captureAuthorization: async (authorizationId) => {
        authId = authorizationId;
        throw new PaypalError({
          operation: "capture authorization",
          paypalName: "UNPROCESSABLE_ENTITY",
          message: "",
          debugId: "dbg-partial",
          issues: [{ issue: "PARTIAL_CAPTURE_NOT_ALLOWED", description: "Partial capture is not enabled for this merchant." }],
          httpStatus: 422,
        });
      },
    };
    const report = await runPaypalCheck({ ...deps, paypal: noPartial });
    expect(report.partialCapture).toBe("DISABLED");
    const row = report.rows.find((r) => r.step === "Partial capture (final_capture)");
    expect(row).toMatchObject({ result: "FAIL", debugId: "dbg-partial" });
    expect(row?.detail).toContain("not enabled for this sandbox merchant");
    expect(report.rows.find((r) => r.step === "Release the test hold")?.result).toBe("PASS");
    expect(inspectMockAuthorization(db, authId)?.status).toBe("VOIDED");
    expect(report.failed).toBe(1);
  });

  it("stops at the token when the credentials are wrong", async () => {
    const { deps } = setup({
      tokens: {
        get: async () => {
          throw new PaypalError({ operation: "OAuth token request", paypalName: "invalid_client", message: "Client Authentication failed", httpStatus: 401 });
        },
        invalidate: () => {},
      },
    });
    const report = await runPaypalCheck(deps);
    expect(report.rows).toEqual([expect.objectContaining({ step: "OAuth token", result: "FAIL" })]);
    expect(report.rows[0]?.detail).toContain("sandbox app's credentials");
  });

  it("skips what it can't test", async () => {
    const { deps } = setup({ waitForApproval: async () => false, payoutReceiver: null, tokens: tokens("openid") });
    const report = await runPaypalCheck(deps);
    expect(report.rows.map((r) => [r.step, r.result])).toEqual([
      ["OAuth token", "PASS"],
      ["Payouts permission", "WARN"],
      ["Create AUTHORIZE order", "PASS"],
      ["Payer approval", "FAIL"],
      ["Partial capture (final_capture)", "SKIP"],
      ["Payout", "SKIP"],
    ]);
    expect(report.partialCapture).toBe("not tested");
  });
});
