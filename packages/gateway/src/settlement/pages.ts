/**
 * The two small HTML pages the gateway serves itself: the PayPal return page (posts a PaypalReturnMessage
 * to the console that opened the popup, then closes) and the offline "Mock PayPal" approval page.
 * Neutral styling with system fonts, no PayPal branding. Every echoed value is HTML-escaped, inline JSON
 * is `<`-escaped, and each response carries a strict CSP that only allows its own nonce'd script/style.
 */
import { randomBytes } from "node:crypto";
import { formatCents, type PaypalReturnMessage } from "@p402/shared";
import type { MockOrder } from "../paypal/mock";

export interface HtmlPage {
  html: string;
  /** Value for the content-security-policy header. */
  csp: string;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/** JSON safe to embed in an inline <script>. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function csp(nonce: string, formAction: string): string {
  return [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "base-uri 'none'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
  ].join("; ");
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--surface:#fff;--ink:#18181b;--muted:#6b6b72;--line:#e4e4e0;--ok:#15803d;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0b0b0c;--surface:#151517;--ink:#f4f4f5;--muted:#a1a1aa;--line:#2a2a2e;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);
font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
main{width:100%;max-width:400px;background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:28px}
.kicker{margin:0 0 4px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
h1{margin:0 0 12px;font-size:20px;letter-spacing:-.01em}
p{margin:0 0 12px;color:var(--muted)}
.amount{margin:16px 0 4px;font-size:34px;font-weight:600;letter-spacing:-.02em;color:var(--ink);font-variant-numeric:tabular-nums}
.what{margin:0 0 20px;color:var(--ink)}
.row{display:flex;gap:10px;margin-top:20px}
button,.button{flex:1;display:inline-block;text-align:center;font:inherit;font-weight:600;padding:10px 14px;border-radius:8px;cursor:pointer;
text-decoration:none;border:1px solid var(--ink);background:var(--ink);color:var(--surface)}
button.secondary{background:transparent;color:var(--ink);border-color:var(--line)}
.ok{color:var(--ok)}.bad{color:var(--bad)}
.fine{margin-top:20px;padding-top:14px;border-top:1px solid var(--line);font-size:12px}
a{color:inherit}
`;

function layout(title: string, body: string, nonce: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`;
}

const RETURN_COPY: Record<PaypalReturnMessage["kind"], Record<PaypalReturnMessage["status"], { title: string; text: string }>> = {
  tab: {
    approved: { title: "Hold approved", text: "Your agents can start spending. This window closes by itself." },
    cancelled: { title: "Hold cancelled", text: "Nothing was authorized. You can close this window." },
    failed: { title: "Hold not approved", text: "PayPal could not authorize the hold." },
  },
  purchase: {
    approved: { title: "Payment complete", text: "The purchase is paid. This window closes by itself." },
    cancelled: { title: "Payment cancelled", text: "Nothing was charged. You can close this window." },
    failed: { title: "Payment not completed", text: "PayPal could not complete the payment." },
  },
};

/**
 * The page PayPal (or the mock) redirects the popup to. It posts `message` to `window.opener` once per
 * allowed origin, then closes itself; the visible text and console link are the fallback when PayPal has
 * severed the opener.
 */
export function returnPage(opts: { message: PaypalReturnMessage; consoleUrl: string; origins: string[] }): HtmlPage {
  const nonce = randomBytes(16).toString("base64");
  const { message } = opts;
  const copy = RETURN_COPY[message.kind][message.status];
  const tone = message.status === "approved" ? "ok" : message.status === "failed" ? "bad" : "";
  const origins = [...new Set(opts.origins.map(originOf).filter((o): o is string => o !== null))];
  const body = `<p class="kicker">402 Fiatality</p>
<h1 class="${tone}">${escapeHtml(copy.title)}</h1>
<p>${escapeHtml(copy.text)}</p>
${message.message ? `<p>${escapeHtml(message.message)}</p>` : ""}
<p class="fine">If this window stays open, close it or <a href="${escapeHtml(opts.consoleUrl)}" rel="noopener">go back to the console</a>.</p>`;
  const script = `(function(){var m=${scriptJson(message)};var o=${scriptJson(origins)};
try{if(window.opener){for(var i=0;i<o.length;i++){try{window.opener.postMessage(m,o[i]);}catch(e){}}}}catch(e){}
setTimeout(function(){try{window.close();}catch(e){}},${message.status === "failed" ? 4000 : 600});})();`;
  return { html: layout(copy.title, body, nonce, script), csp: csp(nonce, "'none'") };
}

/** Shown after approving the order `npm run check:paypal` created (no opener to notify). */
export function checkReturnPage(status: "approved" | "cancelled"): HtmlPage {
  const nonce = randomBytes(16).toString("base64");
  const title = status === "approved" ? "Approved" : "Cancelled";
  const body = `<p class="kicker">402 Fiatality sandbox check</p>
<h1 class="${status === "approved" ? "ok" : "bad"}">${title}</h1>
<p>Go back to the terminal running <code>npm run check:paypal</code> and press Enter.</p>`;
  return { html: layout(`Sandbox check: ${title}`, body, nonce), csp: csp(nonce, "'none'") };
}

/** A plain message page (bad links, unknown orders). */
export function messagePage(title: string, text: string): HtmlPage {
  const nonce = randomBytes(16).toString("base64");
  const body = `<p class="kicker">402 Fiatality</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p>`;
  return { html: layout(title, body, nonce), csp: csp(nonce, "'none'") };
}

/**
 * GET /paypal/mock/approve: the offline stand-in for PayPal's approval page. Approve / Cancel post back
 * to /paypal/mock/approve, which redirects to the order's return or cancel URL like PayPal does.
 */
export function mockApprovalPage(opts: { order: MockOrder; formAction: string; continueUrl: string | null }): HtmlPage {
  const nonce = randomBytes(16).toString("base64");
  const { order } = opts;
  const amount = formatCents(order.amountCents);
  const what =
    order.intent === "AUTHORIZE"
      ? `Authorize a hold of ${amount} for ${order.brandName}. You pay once, only for what your agents use, when the tab closes; the rest of the hold is released.`
      : `Pay ${amount} to ${order.brandName} for ${order.itemName ?? order.description}.`;
  const pending = order.status === "PAYER_ACTION_REQUIRED";
  const actions = pending
    ? `<form method="post" action="/paypal/mock/approve">
<input type="hidden" name="token" value="${escapeHtml(order.id)}">
<div class="row">
<button type="submit" name="action" value="cancel" class="secondary">Cancel</button>
<button type="submit" name="action" value="approve">${order.intent === "AUTHORIZE" ? "Approve hold" : "Pay now"}</button>
</div>
</form>`
    : `<p class="ok">Already approved.</p>${opts.continueUrl ? `<div class="row"><a class="button" href="${escapeHtml(opts.continueUrl)}">Continue</a></div>` : ""}`;
  const body = `<p class="kicker">Mock PayPal (offline demo)</p>
<h1>${escapeHtml(order.description)}</h1>
<p class="amount">${escapeHtml(amount)}</p>
<p class="what">${escapeHtml(what)}</p>
${actions}
<p class="fine">This page simulates PayPal's approval step so the demo runs without network access. No real money moves. Order <code>${escapeHtml(order.id)}</code>.</p>`;
  const formAction = ["'self'", originOf(opts.formAction)].filter(Boolean).join(" ");
  return { html: layout("Mock PayPal (offline demo)", body, nonce), csp: csp(nonce, formAction) };
}
