/**
 * OAuth 2.0 client-credentials token for the PayPal REST API, cached until shortly before it expires.
 * One cache serves both the Server SDK (via its `oAuthTokenProvider` hook) and our own REST calls (Payouts).
 *
 * The credentials live only in this closure, never on an object property, so nothing that logs a client
 * object can leak them. Expiry uses real time (Date.now), not the demo clock.
 */
import { z } from "zod";
import { paypalErrorFromResponse, toPaypalError } from "./errors";

export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";

/** Refresh this long before PayPal's stated expiry. */
const EXPIRY_MARGIN_MS = 60_000;

export interface AccessToken {
  value: string;
  /** Epoch ms (real time) after which we fetch a new token. */
  expiresAt: number;
  /** Space-separated scopes granted to the app (no secrets). */
  scope: string;
}

export interface TokenSource {
  get(): Promise<AccessToken>;
  /** Drop the cached token (after a 401). */
  invalidate(): void;
}

export interface TokenSourceOptions {
  baseUrl?: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().positive(),
  scope: z.string().optional(),
});

export function createTokenSource(opts: TokenSourceOptions): TokenSource {
  const baseUrl = opts.baseUrl ?? PAYPAL_SANDBOX_API;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const basic = `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`, "utf8").toString("base64")}`;

  let cached: AccessToken | null = null;
  let inflight: Promise<AccessToken> | null = null;

  async function fetchToken(): Promise<AccessToken> {
    const operation = "OAuth token request";
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: basic, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: "grant_type=client_credentials",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toPaypalError(err, operation);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw paypalErrorFromResponse(operation, res.status, body, res.headers);
    const parsed = tokenResponseSchema.safeParse(body);
    if (!parsed.success) throw toPaypalError(Object.assign(new Error("bad token response"), { name: "ResponseValidationError" }), operation);
    const ttlMs = parsed.data.expires_in * 1000;
    return {
      value: parsed.data.access_token,
      expiresAt: now() + Math.max(ttlMs - EXPIRY_MARGIN_MS, ttlMs / 2),
      scope: parsed.data.scope ?? "",
    };
  }

  return {
    async get() {
      if (cached && now() < cached.expiresAt) return cached;
      if (!inflight) {
        inflight = fetchToken()
          .then((token) => {
            cached = token;
            return token;
          })
          .finally(() => {
            inflight = null;
          });
      }
      return inflight;
    },
    invalidate() {
      cached = null;
    },
  };
}
