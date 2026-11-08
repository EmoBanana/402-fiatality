/**
 * PayPal approval popups (tab holds and purchases). The gateway's /paypal/return page posts a
 * PaypalReturnMessage to its opener, but PayPal's pages may sever `window.opener`, so callers should also
 * treat the `tab.updated` / `purchase.updated` event (or a refetch) as the source of truth.
 *
 *   const approval = openPaypalApproval(created.approveUrl, config.publicBaseUrl);
 *   const result = await approval.result;   // message, or { status: "closed" } when the window was closed
 *
 * When the URL comes from an API call, open the window first, inside the click handler, so browsers
 * (Safari especially) don't block it after the `await`:
 *
 *   const pending = preparePaypalPopup();              // synchronous, in the click handler
 *   try {
 *     const created = await api.tabs.create(body);
 *     const approval = pending.open(created.approveUrl, config.publicBaseUrl);
 *   } catch (err) {
 *     pending.close();
 *   }
 */
import type { PaypalReturnMessage } from "@p402/shared";

export type PaypalApprovalResult =
  | PaypalReturnMessage
  /** The window was closed without a message, or the browser blocked it. */
  | { type: "p402:paypal-closed"; status: "closed" | "blocked" };

export interface PaypalApproval {
  /** Null when the browser blocked the popup: fall back to a link the user clicks. */
  window: Window | null;
  result: Promise<PaypalApprovalResult>;
  cancel(): void;
}

export interface PendingPaypalPopup {
  /** Null when the browser blocked the popup. */
  window: Window | null;
  /** Point the prepared window at PayPal and start listening for the return message. */
  open(url: string, gatewayOrigin: string): PaypalApproval;
  /** Close the prepared window (e.g. the API call failed). */
  close(): void;
}

const POPUP_NAME = "p402-paypal";

function popupFeatures(): string {
  const width = 480;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  return `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`;
}

/** Resolve with the return message, or "closed" once the user closes the window. */
function watchPopup(popup: Window | null, gatewayOrigin: string): PaypalApproval {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(gatewayOrigin, location.href).origin;
  } catch {
    expectedOrigin = location.origin;
  }

  let cleanup = () => {};
  const result = new Promise<PaypalApprovalResult>((resolve) => {
    if (!popup) {
      resolve({ type: "p402:paypal-closed", status: "blocked" });
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Partial<PaypalReturnMessage> | null;
      if (event.origin !== expectedOrigin || data?.type !== "p402:paypal-return") return;
      cleanup();
      resolve(data as PaypalReturnMessage);
    };
    const timer = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        resolve({ type: "p402:paypal-closed", status: "closed" });
      }
    }, 500);
    cleanup = () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
    };
    window.addEventListener("message", onMessage);
  });

  return {
    window: popup,
    result,
    cancel: () => {
      cleanup();
      popup?.close();
    },
  };
}

export function openPaypalApproval(url: string, gatewayOrigin: string): PaypalApproval {
  const popup = window.open(url, POPUP_NAME, popupFeatures());
  return watchPopup(popup, gatewayOrigin);
}

/** Open an empty popup now (inside the click handler) and navigate it to PayPal later. */
export function preparePaypalPopup(): PendingPaypalPopup {
  const popup = window.open("", POPUP_NAME, popupFeatures());
  if (popup) {
    try {
      const doc = popup.document;
      doc.title = "Opening PayPal";
      doc.body.setAttribute(
        "style",
        "margin:0;height:100vh;display:grid;place-items:center;font:14px/1.5 system-ui,-apple-system,sans-serif;color:#3f3f46;background:#fafaf8",
      );
      doc.body.textContent = "Opening PayPal…";
    } catch {
      // The named window is already on PayPal (cross-origin); it is about to be navigated anyway.
    }
  }
  return {
    window: popup,
    open(url, gatewayOrigin) {
      if (!popup) return watchPopup(null, gatewayOrigin);
      if (popup.closed) {
        // The user closed the placeholder window before PayPal's URL arrived.
        return { window: null, result: Promise.resolve({ type: "p402:paypal-closed", status: "closed" }), cancel: () => {} };
      }
      popup.location.href = url;
      try {
        popup.focus();
      } catch {
        // focus is best effort
      }
      return watchPopup(popup, gatewayOrigin);
    },
    close() {
      try {
        popup?.close();
      } catch {
        // already gone
      }
    },
  };
}
