/** `npm run check:paypal`'s flow, run offline against the mock PayPal (the real run needs a human and the sandbox). */
import pino from "pino";
import { describe, expect, it } from "vitest";
import type { PaypalClient } from "../context";
import { openDb } from "../db/db";
import { formatCheckTable, runPaypalCheck, type CheckDeps } from "./check";
import { PaypalError } from "./errors";
import { approveMockOrder, createMockPaypal, inspectMockAuthorization } from "./mock";
import type { TokenSource } from "./oauth";

// The scope as a real sandbox token lists it, next to a lookalike that isn't Payouts.
const tokens = (scope = "openid https://uri.paypal.com/services/payments/referenced-payouts-items/readwrite https://uri.paypal.com/payments/payouts"): TokenSource => ({
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

  it("lists disputes and records the capture as a paid invoice when asked", async () => {
    const { deps } = setup({ checkDisputes: true, invoiceRecords: true });
    const report = await runPaypalCheck(deps);
    expect(report.failed).toBe(0);
    expect(report.rows.map((r) => r.step)).toEqual([
      "OAuth token",
      "Payouts permission",
      "Disputes API (read-only)",
      "Create AUTHORIZE order",
      "Payer approval",
      "Authorize",
      "Partial capture (final_capture)",
      "Fee from seller_receivable_breakdown",
      "Rest of the hold released",
      "Invoice record",
      "Create payout batch",
      "Payout status",
    ]);
    expect(report.rows.find((r) => r.step === "Disputes API (read-only)")).toMatchObject({ result: "PASS", detail: "0 dispute(s) in the last 180 days, 0 open" });
    expect(report.rows.find((r) => r.step === "Invoice record")).toMatchObject({ result: "PASS" });
    expect(report.rows.find((r) => r.step === "Invoice record")?.detail).toMatch(/^invoice MOCK-INV-\w+ for \$1\.23: MARKED_AS_PAID$/);

    const off = await runPaypalCheck(setup({ invoiceRecords: false }).deps);
    expect(off.rows.find((r) => r.step === "Invoice record")).toMatchObject({ result: "SKIP" });

    const { deps: broken, paypal } = setup({ checkDisputes: true });
    const failing = await runPaypalCheck({
      ...broken,
      paypal: {
        ...paypal,
        mode: paypal.mode,
        listDisputes: async () => {
          throw new PaypalError({ operation: "list disputes", paypalName: "NOT_AUTHORIZED", message: "", debugId: "dbg-d", httpStatus: 403 });
        },
      },
    });
    expect(failing.rows.find((r) => r.step === "Disputes API (read-only)")).toMatchObject({ result: "FAIL", debugId: "dbg-d" });
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

  it("picks up Payouts enabled on the app while the hold waited for approval", async () => {
    let appScope = "openid";
    let cached: Awaited<ReturnType<TokenSource["get"]>> | null = null;
    const source: TokenSource = {
      get: async () => (cached ??= { value: "token", expiresAt: Date.now() + 3_600_000, scope: appScope }),
      invalidate: () => {
        cached = null;
      },
    };
    const { db, deps } = setup({ tokens: source });
    const report = await runPaypalCheck({
      ...deps,
      waitForApproval: async (orderId) => {
        appScope = "openid https://uri.paypal.com/payments/payouts"; // the user ticks Payouts meanwhile
        return approveMockOrder(db, orderId) !== null;
      },
    });
    expect(report.rows.filter((r) => r.step === "Payouts permission").map((r) => r.result)).toEqual(["WARN", "PASS"]);
    expect(report.rows.at(-1)).toMatchObject({ step: "Payout status", result: "PASS" });
    expect(report.failed).toBe(0);
  });

  it("skips what it can't test", async () => {
    const lookalikeOnly = tokens("openid https://uri.paypal.com/services/payments/referenced-payouts-items/readwrite");
    const { deps } = setup({ waitForApproval: async () => false, payoutReceiver: null, tokens: lookalikeOnly });
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
