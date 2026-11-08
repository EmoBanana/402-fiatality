/**
 * What happens when PayPal sends the payer back (GET /paypal/return | /paypal/cancel): authorize the tab's
 * hold or capture the purchase, or record the cancellation. Never throws: the return page always renders
 * and reports the outcome to the console.
 */
import type { PaypalReturnMessage } from "@p402/shared";
import { approveTab, type ApprovalKind, cancelTab, returnMessage } from "./holds";
import { approvePurchase, cancelPurchase } from "./purchases";
import { errorFields, type SettlementContext } from "./store";

export async function completeApproval(ctx: SettlementContext, kind: ApprovalKind, ref: string, token: string): Promise<PaypalReturnMessage> {
  try {
    return kind === "tab" ? await approveTab(ctx, ref, token) : await approvePurchase(ctx, ref, token);
  } catch (err) {
    ctx.log.error({ kind, ref, ...errorFields(err) }, "PayPal return handling failed");
    return returnMessage(kind, ref, "failed", "Something went wrong while confirming with PayPal. Try again from the console.");
  }
}

export async function cancelApproval(ctx: SettlementContext, kind: ApprovalKind, ref: string, token: string): Promise<PaypalReturnMessage> {
  try {
    return kind === "tab" ? await cancelTab(ctx, ref, token) : await cancelPurchase(ctx, ref, token);
  } catch (err) {
    ctx.log.error({ kind, ref, ...errorFields(err) }, "PayPal cancel handling failed");
    return returnMessage(kind, ref, "failed", "Something went wrong while recording the cancellation.");
  }
}
