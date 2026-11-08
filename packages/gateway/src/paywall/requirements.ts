/** x402 PaymentRequirements / PaymentRequired for one paywalled endpoint (SPEC §5.3 step 2). */
import {
  X402_SCHEME,
  X402_VERSION,
  type PaymentRequired,
  type PaymentRequiredReason,
  type PaymentRequirements,
  type PaypalNetwork,
} from "@p402/shared";
import type { AppContext } from "../context";
import { voidRulesOf, type EndpointRow, type SellerRow } from "../db/dto";

/** How long a signed voucher may live (exp - iat), and PaymentRequirements.maxTimeoutSeconds. */
export const MAX_VOUCHER_TTL_SEC = 300;

export function paypalNetwork(ctx: AppContext): PaypalNetwork {
  return `paypal:${ctx.config.paypal.mode}`;
}

export interface RequirementExtras {
  reason?: PaymentRequiredReason;
  message?: string;
  expectedSeq?: number;
  expectedCumulative?: string;
  retryAfterSec?: number;
}

export function paymentRequirements(
  ctx: AppContext,
  seller: SellerRow,
  endpoint: EndpointRow,
  extras: RequirementExtras = {},
): PaymentRequirements {
  const base = ctx.config.publicBaseUrl;
  return {
    scheme: X402_SCHEME,
    network: paypalNetwork(ctx),
    asset: "USD",
    amount: String(endpoint.price_micros),
    payTo: seller.id,
    maxTimeoutSeconds: MAX_VOUCHER_TTL_SEC,
    extra: {
      decimals: 6,
      endpointId: endpoint.id,
      tabEndpoint: `${base}/api/tabs`,
      catalogUrl: `${base}/api/catalog`,
      voidRules: voidRulesOf(seller),
      ...Object.fromEntries(Object.entries(extras).filter(([, v]) => v !== undefined)),
    },
  };
}

export function paymentRequired(
  ctx: AppContext,
  seller: SellerRow,
  endpoint: EndpointRow,
  resourceUrl: string,
  extras: RequirementExtras,
): PaymentRequired {
  return {
    x402Version: X402_VERSION,
    error: extras.message,
    resource: { url: resourceUrl, description: endpoint.description ?? undefined, mimeType: "application/json" },
    accepts: [paymentRequirements(ctx, seller, endpoint, extras)],
  };
}
