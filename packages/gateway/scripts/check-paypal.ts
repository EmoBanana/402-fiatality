/**
 * npm run check:paypal: a human runs this on the Mac against the PayPal sandbox (SPEC §6.7) before switching
 * PAYPAL_MODE=sandbox. It creates a $5.00 hold, waits while you approve it in the browser with the sandbox
 * *personal* account, captures $1.23 with final_capture, checks the rest was released, sends a $0.50 payout
 * to SELLER_PAYPAL_EMAIL_CHANNEL3 (skipped when unset) and prints a pass/fail table with PayPal debug_ids,
 * including whether partial capture is enabled. Exit code 1 when a step failed.
 *
 * Needs the sandbox credentials in .env whatever PAYPAL_MODE says. Never prints credentials or tokens.
 */
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
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

async function promptApproval(paypal: PaypalClient, publicBaseUrl: string, orderId: string, approveUrl: string): Promise<boolean> {
  console.log(`\n${ansi(1, "Approve the $5.00 hold in your browser:")}\n\n  ${approveUrl}\n`);
  console.log("Log in with your sandbox PERSONAL (buyer) account (developer.paypal.com → Testing Tools → Sandbox Accounts)");
  console.log(`and approve. PayPal then redirects to ${publicBaseUrl}/paypal/return; it's fine if that page doesn't load.\n`);
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const answer = await rl.question(`Press Enter once you have approved it${attempt > 1 ? " (or type q to give up)" : ""}... `);
      if (answer.trim().toLowerCase() === "q") return false;
      const order = await paypal.getOrder(orderId);
      if (order.status === "APPROVED") return true;
      console.log(`  The order is ${order.status}, not APPROVED yet. Log in with the sandbox personal account and approve it.`);
    }
    return false;
  } finally {
    rl.close();
  }
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
    waitForApproval: (orderId, approveUrl) => promptApproval(paypal, config.publicBaseUrl, orderId, approveUrl),
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
