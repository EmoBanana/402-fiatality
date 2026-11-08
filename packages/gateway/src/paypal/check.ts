/**
 * The sandbox money-path check behind `npm run check:paypal` (SPEC §6.7), kept free of process/terminal
 * concerns so tests can run it offline against the mock:
 *
 *   OAuth token -> AUTHORIZE order -> human approval -> authorize -> partial capture with final_capture
 *   -> the rest of the hold is released -> a tiny payout
 *
 * Every step becomes a row (PASS / FAIL / WARN / SKIP) with PayPal's debug_id when there is one.
 */
import { formatCents } from "@p402/shared";
import type { PaypalAuthorization, PaypalClient } from "../context";
import { PaypalError } from "./errors";
import type { TokenSource } from "./oauth";

export const CHECK_HOLD_CENTS = 500;
export const CHECK_CAPTURE_CENTS = 123;
export const CHECK_PAYOUT_CENTS = 50;

export type CheckResult = "PASS" | "FAIL" | "WARN" | "SKIP";

export interface CheckRow {
  step: string;
  result: CheckResult;
  detail: string;
  debugId: string | null;
}

export interface CheckReport {
  rows: CheckRow[];
  /** "ENABLED", "DISABLED", or why it is unknown. */
  partialCapture: string;
  failed: number;
}

export interface CheckDeps {
  paypal: PaypalClient;
  tokens: TokenSource;
  publicBaseUrl: string;
  /** Receives the payout; null skips the payout step. */
  payoutReceiver: string | null;
  /** Show the approve URL and resolve true once the human says the order is approved (false = give up). */
  waitForApproval(orderId: string, approveUrl: string): Promise<boolean>;
  /** Called as each row is recorded (live progress). */
  onRow?(row: CheckRow): void;
  runId?: string;
  sleep?(ms: number): Promise<void>;
}

const issueText = (err: PaypalError) => [err.paypalName, ...err.issues.flatMap((i) => [i.issue, i.description ?? ""])].join(" ");

/** A disabled partial capture shows up as a 422 (or 403) whose issue mentions partial or multiple captures. */
export function looksLikePartialCaptureDisabled(err: unknown): err is PaypalError {
  return err instanceof PaypalError && (err.httpStatus === 422 || err.httpStatus === 403) && /PARTIAL|MULTIPLE/i.test(issueText(err));
}

export const PARTIAL_CAPTURE_HINT =
  "Partial capture of PayPal-wallet authorizations is not enabled for this sandbox merchant. Ask PayPal (developer " +
  "support or your account team) to enable partial/multiple captures for the account, or try a fresh sandbox " +
  "business account; until then PayPal 402 can only capture the full hold";

export async function runPaypalCheck(deps: CheckDeps): Promise<CheckReport> {
  const { paypal, tokens } = deps;
  const runId = deps.runId ?? Date.now().toString(36);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const rows: CheckRow[] = [];
  let partialCapture = "not tested";

  const record = (step: string, result: CheckResult, detail: string, debugId: string | null = null) => {
    const row = { step, result, detail, debugId };
    rows.push(row);
    deps.onRow?.(row);
  };
  const failure = (step: string, err: unknown, hint?: string) => {
    if (err instanceof PaypalError) {
      const issue = err.issues[0];
      const what = issue ? `${issue.issue}${issue.description ? ` (${issue.description})` : ""}` : err.paypalName;
      record(step, "FAIL", `${what}${err.httpStatus ? ` [HTTP ${err.httpStatus}]` : ""}${hint ? `. ${hint}` : ""}`, err.debugId);
    } else {
      record(step, "FAIL", `${err instanceof Error ? err.message : String(err)}${hint ? `. ${hint}` : ""}`);
    }
  };
  const report = (): CheckReport => ({ rows, partialCapture, failed: rows.filter((r) => r.result === "FAIL").length });

  // 1. OAuth
  try {
    const token = await tokens.get();
    const minutes = Math.max(0, Math.round((token.expiresAt - Date.now()) / 60_000));
    record("OAuth token", "PASS", `client-credentials token issued (valid ~${minutes} min)`);
    const payoutsScope = token.scope.includes("/services/payments/payouts");
    record(
      "Payouts permission",
      payoutsScope ? "PASS" : "WARN",
      payoutsScope ? "the app's token includes the Payouts scope" : "the token lacks the Payouts scope: enable Payouts on the REST app",
    );
  } catch (err) {
    failure("OAuth token", err, "Check that PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are the sandbox app's credentials");
    return report();
  }

  // 2. Hold: an AUTHORIZE order a human approves, then authorize it
  let authorization: PaypalAuthorization | null = null;
  let step = "Create AUTHORIZE order";
  try {
    const order = await paypal.createAuthorizeOrder({
      referenceId: `check_${runId}`,
      amountCents: CHECK_HOLD_CENTS,
      description: "PayPal 402 sandbox check",
      softDescriptor: "PP402 CHECK",
      brandName: "PayPal 402",
      returnUrl: `${deps.publicBaseUrl}/paypal/return?kind=check&ref=check`,
      cancelUrl: `${deps.publicBaseUrl}/paypal/cancel?kind=check&ref=check`,
      requestId: `check-hold-${runId}`,
    });
    if (!order.approveUrl) throw new Error("PayPal returned no approval link");
    record(step, "PASS", `order ${order.id} for ${formatCents(CHECK_HOLD_CENTS)} (${order.status})`);

    step = "Payer approval";
    if (!(await deps.waitForApproval(order.id, order.approveUrl))) {
      record(step, "FAIL", "the order was not approved");
    } else {
      record(step, "PASS", "order APPROVED by the sandbox buyer");
      step = "Authorize";
      authorization = await paypal.authorizeOrder(order.id, `check-authorize-${runId}`);
      const expires = authorization.expiresAt ? new Date(authorization.expiresAt).toISOString().slice(0, 10) : "unknown";
      record(
        step,
        authorization.status === "CREATED" ? "PASS" : "WARN",
        `authorization ${authorization.id}: ${authorization.status}, ${formatCents(authorization.amountCents)}, expires ${expires}`,
      );
    }
  } catch (err) {
    failure(step, err);
  }

  // 3. Partial capture with final_capture, then make sure nothing stays on hold
  if (authorization) {
    const authId = authorization.id;
    const rest = formatCents(CHECK_HOLD_CENTS - CHECK_CAPTURE_CENTS);
    try {
      const capture = await paypal.captureAuthorization(authId, {
        amountCents: CHECK_CAPTURE_CENTS,
        finalCapture: true,
        invoiceId: `check-${runId}`,
        noteToPayer: "PayPal 402 sandbox check",
        requestId: `check-capture-${runId}`,
      });
      partialCapture = "ENABLED";
      record(
        "Partial capture (final_capture)",
        capture.status === "COMPLETED" ? "PASS" : "WARN",
        `captured ${formatCents(capture.amountCents)} of ${formatCents(CHECK_HOLD_CENTS)}: ${capture.status}, capture ${capture.id}`,
      );
      record(
        "Fee from seller_receivable_breakdown",
        capture.feeCents == null ? "WARN" : "PASS",
        capture.feeCents == null
          ? "PayPal reported no paypal_fee (settlement would fall back to the published rate)"
          : `paypal_fee ${formatCents(capture.feeCents)}`,
      );
      const after = await paypal.getAuthorization(authId);
      try {
        await paypal.voidAuthorization(authId, `check-void-${runId}`);
        record("Rest of the hold released", "PASS", `PayPal still held ${rest} after final_capture (${after.status}); a void released it, as closeTab does`);
      } catch (err) {
        if (err instanceof PaypalError && err.httpStatus === 422) {
          record("Rest of the hold released", "PASS", `final_capture released the remaining ${rest} (authorization ${after.status}, nothing left to void)`);
        } else {
          failure("Rest of the hold released", err);
        }
      }
    } catch (err) {
      if (looksLikePartialCaptureDisabled(err)) {
        partialCapture = "DISABLED";
        failure("Partial capture (final_capture)", err, PARTIAL_CAPTURE_HINT);
      } else {
        partialCapture = "unknown (the capture failed for another reason)";
        failure("Partial capture (final_capture)", err);
      }
      try {
        await paypal.voidAuthorization(authId, `check-cleanup-${runId}`);
        record("Release the test hold", "PASS", "voided the test authorization");
      } catch (voidErr) {
        failure("Release the test hold", voidErr);
      }
    }
  } else {
    record("Partial capture (final_capture)", "SKIP", "no authorization to capture");
  }

  // 4. Payout
  if (!deps.payoutReceiver) {
    record("Payout", "SKIP", "set SELLER_PAYPAL_EMAIL_CHANNEL3 to a sandbox personal account email to test payouts");
    return report();
  }
  try {
    const batch = await paypal.createPayoutBatch({
      senderBatchId: `check-${runId}`,
      emailSubject: "PayPal 402 sandbox check",
      note: "PayPal 402 sandbox check",
      items: [
        { senderItemId: `check-${runId}:channel3`, receiverEmail: deps.payoutReceiver, amountCents: CHECK_PAYOUT_CENTS, note: "PayPal 402 sandbox check" },
      ],
    });
    record("Create payout batch", "PASS", `batch ${batch.batchId} (${batch.status}) for ${formatCents(CHECK_PAYOUT_CENTS)}`);
    let final = batch;
    for (let i = 0; i < 10 && !["SUCCESS", "DENIED", "CANCELED"].includes(final.status); i++) {
      await sleep(2_000);
      final = await paypal.getPayoutBatch(batch.batchId);
    }
    const item = final.items[0];
    const itemText = item ? `item ${item.status}${item.feeCents != null ? `, fee ${formatCents(item.feeCents)}` : ""}` : "no item details yet";
    const failedItem = item !== undefined && ["FAILED", "RETURNED", "BLOCKED", "DENIED"].includes(item.status);
    const result: CheckResult = final.status === "DENIED" || failedItem ? "FAIL" : final.status === "SUCCESS" ? "PASS" : "WARN";
    record("Payout status", result, `batch ${final.status}, ${itemText}${result === "WARN" ? " (still processing; check the sandbox dashboard)" : ""}`);
  } catch (err) {
    const hint =
      err instanceof PaypalError && (err.httpStatus === 403 || /AUTHORIZATION_ERROR|NOT_AUTHORIZED|PERMISSION/i.test(issueText(err)))
        ? "Enable Payouts for this REST app (developer.paypal.com → Apps & Credentials → your app → Features)"
        : err instanceof PaypalError && /INSUFFICIENT_FUNDS/i.test(issueText(err))
          ? "Add funds to the sandbox business account"
          : undefined;
    failure("Create payout batch", err, hint);
  }
  return report();
}

/** The final pass/fail table. `paint` colors a result cell (identity when not a TTY). */
export function formatCheckTable(report: CheckReport, paint: (result: CheckResult, text: string) => string = (_r, t) => t): string {
  const header = { step: "Step", result: "Result", debugId: "debug_id", detail: "Detail" };
  const widthOf = (values: string[]) => Math.max(...values.map((v) => v.length));
  const ws = widthOf([header.step, ...report.rows.map((r) => r.step)]);
  const wr = widthOf([header.result, ...report.rows.map((r) => r.result)]);
  const wd = widthOf([header.debugId, ...report.rows.map((r) => r.debugId ?? "-")]);
  const lines = [
    `${header.step.padEnd(ws)}  ${header.result.padEnd(wr)}  ${header.debugId.padEnd(wd)}  ${header.detail}`,
    ...report.rows.map((r) => `${r.step.padEnd(ws)}  ${paint(r.result, r.result.padEnd(wr))}  ${(r.debugId ?? "-").padEnd(wd)}  ${r.detail}`),
    "",
    `Partial capture: ${report.partialCapture}`,
  ];
  return lines.join("\n");
}
