/**
 * The x402 paywall: ALL /s/:sellerId/* (SPEC §5.3). No PayPal call on this path: a paid call is verified
 * locally (Ed25519 voucher, channel sequence, policy), reserved, forwarded to the seller, judged by the quality
 * guard and answered with PAYMENT-RESPONSE. The raw body is kept as bytes so the request hash matches what the
 * agent signed, and the same bytes are forwarded.
 */
import {
  formatUsd,
  X402_HEADERS,
  X402_SCHEME,
  type SettlementResponse,
} from "@p402/shared";
import { encodeX402Header } from "@p402/shared/node";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError, type AppContext, type RoutePlugin } from "../context";
import { coreOf } from "../core";
import { voidRulesOf, type EndpointRow, type SellerRow } from "../db/dto";
import { getSellerRow, sellerAuth, sellerEndpoints } from "../sellers/registry";
import { finalizeVoucher, reserveVoucher, responseExcerpt } from "./ledger";
import { isForwardablePath, matchEndpoint, splitPathAndQuery } from "./match";
import { forward } from "./proxy";
import { judgeResponse } from "./quality";
import { paymentRequired, paypalNetwork } from "./requirements";
import { decodePaymentHeader, verifyPayment, type Rejection } from "./verify";

/** Request bodies the paywall accepts (agents' JSON queries are tiny). */
export const PAYWALL_BODY_LIMIT = 1024 * 1024;

/** "/s/channel3/v1/search?q=x" -> "/v1/search?q=x", from the raw URL exactly as the agent sent (and signed) it. */
export function pathAfterSeller(rawUrl: string): string {
  const rest = rawUrl.slice("/s/".length);
  const slash = rest.indexOf("/");
  return slash === -1 ? "/" : rest.slice(slash);
}

interface Target {
  seller: SellerRow;
  endpoint: EndpointRow;
  resourceUrl: string;
}

function sendPaymentRequired(ctx: AppContext, reply: FastifyReply, target: Target, rejection: Rejection): FastifyReply {
  const body = paymentRequired(ctx, target.seller, target.endpoint, target.resourceUrl, rejection);
  void reply.code(402).header(X402_HEADERS.required, encodeX402Header(body));
  if (rejection.retryAfterSec !== undefined) void reply.header("retry-after", String(rejection.retryAfterSec));
  return reply.type("application/json; charset=utf-8").send(body);
}

async function handlePaidCall(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { sellerId } = request.params as { sellerId: string };
  const method = request.method;
  const pathWithQuery = pathAfterSeller(request.url);
  const { path } = splitPathAndQuery(pathWithQuery);

  const seller = getSellerRow(ctx, sellerId);
  if (!seller) throw new AppError(404, "seller_not_found", `No seller "${sellerId}" is listed.`);
  if (seller.status !== "active") throw new AppError(503, "seller_paused", `${seller.name} is not taking calls right now.`);
  const endpoint = isForwardablePath(path) ? matchEndpoint(sellerEndpoints(ctx, seller.id), method, path) : null;
  if (!endpoint) throw new AppError(404, "endpoint_not_found", `${seller.name} sells no ${method} ${path}. See /api/catalog.`);
  const target: Target = { seller, endpoint, resourceUrl: `${ctx.config.publicBaseUrl}/s/${seller.id}${pathWithQuery}` };

  const header = request.headers[X402_HEADERS.signature.toLowerCase()];
  if (typeof header !== "string" || header.length === 0) {
    return sendPaymentRequired(ctx, reply, target, {
      reason: "payment_required",
      message: `This call costs ${formatUsd(endpoint.price_micros)}. Open a tab, then sign a ${X402_SCHEME} voucher.`,
    });
  }

  const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  const core = coreOf(ctx);
  const decoded = decodePaymentHeader(ctx, header);
  if (!decoded.ok) return sendPaymentRequired(ctx, reply, target, decoded.rejection);
  const verified = verifyPayment(ctx, decoded.value, {
    sellerId: seller.id,
    endpoint,
    method,
    pathWithQuery,
    rawBody,
    retryAfterSec: (tabId) => core.reviews.retryAfterSec(tabId),
  });
  if (!verified.ok) return sendPaymentRequired(ctx, reply, target, verified.rejection);

  const auth = sellerAuth(ctx, seller);
  const reserved = reserveVoucher(ctx, verified.value, { sellerId: seller.id, endpoint, method, pathWithQuery, rawBody, signatureHeader: header });
  if (!reserved.ok) return sendPaymentRequired(ctx, reply, target, reserved.rejection);
  const { voucherId } = reserved.value;
  const { voucher } = verified.value;

  const voidRules = voidRulesOf(seller);
  const result = await forward({
    baseUrl: seller.base_url,
    pathWithQuery,
    method,
    clientHeaders: request.headers,
    body: rawBody,
    timeoutMs: voidRules.timeoutMs,
    demo: ctx.config.demo,
    auth,
    voucherId,
  });
  const judgement = judgeResponse(result, voidRules, endpoint.response_schema);
  const body = result.kind === "response" ? result.body : Buffer.alloc(0);
  const dto = finalizeVoucher(ctx, voucherId, {
    status: judgement.status,
    voidReason: judgement.voidReason,
    httpStatus: result.kind === "response" || result.kind === "too_large" ? result.status : null,
    latencyMs: result.latencyMs,
    responseBytes: body.length,
    responseExcerpt: responseExcerpt(body) ?? (judgement.detail ? `[gateway] ${judgement.detail}` : null),
  });
  ctx.bus.emit(dto.status === "accepted" ? "voucher.accepted" : "voucher.voided", dto);
  core.afterVoucher(dto.tabId, dto.status, voucher.reqHash);
  if (judgement.status === "voided") {
    request.log.info({ voucherId, sellerId: seller.id, reason: judgement.voidReason, detail: judgement.detail }, "voucher voided");
  }

  const settlement: SettlementResponse = {
    success: dto.status === "accepted",
    scheme: X402_SCHEME,
    network: paypalNetwork(ctx),
    transaction: voucherId,
    status: dto.status,
    amount: dto.status === "accepted" ? String(dto.priceMicros) : "0",
    cumulative: String(dto.cumulativeMicros),
    ...(judgement.voidReason ? { reason: judgement.voidReason } : {}),
  };
  void reply.header(X402_HEADERS.response, encodeX402Header(settlement));

  if (result.kind === "response") {
    return reply
      .code(result.status)
      .type(result.contentType ?? "application/octet-stream")
      .send(result.body);
  }
  const status = result.kind === "timeout" ? 504 : 502;
  const message =
    result.kind === "timeout"
      ? `${seller.name} did not answer within ${voidRules.timeoutMs} ms. You were not charged.`
      : result.kind === "too_large"
        ? `${seller.name} sent more than 2 MB. You were not charged.`
        : `${seller.name} could not be reached. You were not charged.`;
  return reply
    .code(status)
    .type("application/json; charset=utf-8")
    .send({ error: judgement.voidReason ?? "upstream_unreachable", message });
}

export const paywallRoutes: RoutePlugin = async (app, { ctx }) => {
  // Scoped to this plugin: keep every body as raw bytes (hashing and forwarding need the exact bytes).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: PAYWALL_BODY_LIMIT }, (_request, body, done) => done(null, body));
  app.all("/s/:sellerId/*", (request, reply) => handlePaidCall(ctx, request, reply));
};
