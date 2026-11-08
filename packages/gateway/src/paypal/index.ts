/**
 * PaypalClient factory (SPEC §6.1): the offline mock or the PayPal sandbox, chosen by PAYPAL_MODE.
 * Phase 2 wires it in src/services.ts as `paypal: (ctx) => createPaypalClient(ctx)`.
 */
import type { AppContext, PaypalClient } from "../context";
import { createMockPaypal } from "./mock";
import { createSandboxPaypal } from "./sandbox";

export { PaypalError, toPaypalError, type PaypalErrorDetails, type PaypalIssue } from "./errors";
export { approveMockOrder, createMockPaypal, getMockOrder, mockApproveUrl, type MockOrder } from "./mock";
export { createSandboxPaypal } from "./sandbox";

/** The clock is optional (the context passes it): the mock ages holds with the demo clock when present. */
export type PaypalClientDeps = Pick<AppContext, "config" | "db" | "log"> & Partial<Pick<AppContext, "clock">>;

export function createPaypalClient(ctx: PaypalClientDeps): PaypalClient {
  if (ctx.config.paypal.mode === "sandbox") return createSandboxPaypal(ctx);
  return createMockPaypal({ config: ctx.config, db: ctx.db, log: ctx.log, clock: ctx.clock });
}
