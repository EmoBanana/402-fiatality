/**
 * PayPal approval popups (tab holds and purchases). The gateway's /paypal/return page posts a
 * PaypalReturnMessage to its opener, but PayPal's pages may sever `window.opener`, so callers should also
 * treat the `tab.updated` / `purchase.updated` event (or a refetch) as the source of truth.
 *
 *   const approval = openPaypalApproval(created.approveUrl, config.publicBaseUrl);
 *   const result = await approval.result;   // message, or { status: "closed" } when the window was closed
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

export function openPaypalApproval(url: string, gatewayOrigin: string): PaypalApproval {
  const width = 480;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  const popup = window.open(url, "p402-paypal", `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  const expectedOrigin = new URL(gatewayOrigin, location.href).origin;

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
