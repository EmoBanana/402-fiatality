/**
 * npm run check:paypal: a human runs this on the Mac against the PayPal sandbox (SPEC §6.7) before switching
 * PAYPAL_MODE=sandbox. It creates a $5.00 hold, waits while you approve it in the browser with the sandbox
 * *personal* account, captures $1.23 with final_capture, checks the rest was released, sends a $0.50 payout
 * to SELLER_PAYPAL_EMAIL_CHANNEL3 (skipped when unset) and prints a pass/fail table with PayPal debug_ids,
 * including whether partial capture is enabled. It also lists disputes (read-only, proving the Disputes API
 * answers) and, with PAYPAL_INVOICE_RECORDS=1, records the $1.23 capture as a paid invoice. Exit code 1 when a
 * step failed.
 *
 * Needs the sandbox credentials in .env whatever PAYPAL_MODE says. Never prints credentials or tokens.
 */
import { stdout } from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import pino from "pino";
import { type AppConfig, ConfigError, loadConfig, loadDotEnv } from "../src/config";
import type { PaypalClient } from "../src/context";
import { type CheckResult, formatCheckTable, runPaypalCheck } from "../src/paypal/check";
import { createTokenSource, PAYPAL_SANDBOX_API } from "../src/paypal/oauth";
import { createSandboxPaypal } from "../src/paypal/sandbox";

const useColor = stdout.isTTY && !process.env.NO_COLOR;
const COLORS: Record<CheckResult, number> = { PASS: 32, FAIL: 31, WARN: 33, SKIP: 90 };
const ansi = (code: number, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const paint = (result: CheckResult, text: string) => ansi(COLORS[result], text);

function sandboxConfig(): AppConfig {
  loadDotEnv();
  try {
    return loadConfig({ ...process.env, PAYPAL_MODE: "sandbox" });
  } catch (err) {
    console.error(`${ansi(31, "Cannot run the sandbox check:")} ${err instanceof ConfigError ? err.message : String(err)}`);
    console.error("Put the sandbox REST app's PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env (developer.paypal.com → Apps & Credentials).");
    process.exit(1);
  }
}

/** How often, and for how long, the check looks at the order while you approve it. */
const APPROVAL_POLL_MS = 3_000;
const APPROVAL_WAIT_MS = 30 * 60_000;

async function awaitApproval(paypal: PaypalClient, publicBaseUrl: string, orderId: string, approveUrl: string): Promise<boolean> {
  console.log(`\n${ansi(1, "Approve the $5.00 hold in your browser:")}\n\n  ${approveUrl}\n`);
  console.log("Log in with your sandbox PERSONAL (buyer) account (developer.paypal.com → Testing Tools → Sandbox Accounts)");
  console.log(`and approve. PayPal then redirects to ${publicBaseUrl}/paypal/return; it's fine if that page doesn't load.\n`);
  console.log(`Waiting for the approval (up to ${APPROVAL_WAIT_MS / 60_000} min; Ctrl+C gives up)...`);
  const deadline = Date.now() + APPROVAL_WAIT_MS;
  while (Date.now() < deadline) {
    // A failed lookup (network blip) just means asking again on the next poll.
    const status = await paypal.getOrder(orderId).then((order) => order.status, () => null);
    if (status === "APPROVED") return true;
    if (status === "VOIDED" || status === "COMPLETED") {
      console.log(`  The order is ${status}; it can no longer be approved.`);
      return false;
    }
    await sleep(APPROVAL_POLL_MS);
  }
  console.log("  No approval arrived in time.");
  return false;
}

async function main(): Promise<void> {
  const config = sandboxConfig();
  const { clientId, clientSecret } = config.paypal;
  if (!clientId || !clientSecret) throw new Error("sandbox credentials missing");
  const tokens = createTokenSource({ baseUrl: PAYPAL_SANDBOX_API, clientId, clientSecret });
  const paypal = createSandboxPaypal({ config, log: pino({ level: "silent" }) }, { tokens });

  console.log(ansi(1, "\n402 Fiatality: sandbox check"));
  console.log(`API ${PAYPAL_SANDBOX_API} · PAYPAL_MODE in .env: ${process.env.PAYPAL_MODE || "mock"}\n`);

  const report = await runPaypalCheck({
    paypal,
    tokens,
    publicBaseUrl: config.publicBaseUrl,
    payoutReceiver: config.sellerEmails.channel3,
    checkDisputes: true,
    invoiceRecords: config.paypal.invoiceRecords,
    waitForApproval: (orderId, approveUrl) => awaitApproval(paypal, config.publicBaseUrl, orderId, approveUrl),
    onRow: (row) => console.log(`  ${paint(row.result, row.result.padEnd(4))}  ${row.step}: ${row.detail}${row.debugId ? `  (debug_id ${row.debugId})` : ""}`),
  });

  console.log(`\n${ansi(1, "PayPal sandbox check")}\n${formatCheckTable(report, paint)}`);
  console.log(report.failed === 0 ? ansi(32, "\nAll checks passed.") : ansi(31, `\n${report.failed} check(s) failed.`));
  process.exit(report.failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(ansi(31, `Unexpected error: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
