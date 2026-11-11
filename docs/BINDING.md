# x402 `batch-settlement` on PayPal

This document specifies how 402 Fiatality binds the x402 v2 `batch-settlement` scheme to PayPal, on the networks `paypal:mock` (an offline simulator) and `paypal:sandbox` (PayPal's sandbox). It is precise enough to build a compatible client, and it describes what the gateway in this repository actually does.

`batch-settlement` is network-agnostic and anticipates fiat billing: instead of settling every request, the buyer authorizes funds once and signs a commitment per request, and the commitments are redeemed later in a batch. Every binding must define seven things, each in its own section below:

1. [Commitment format](#1-commitment-format)
2. [Verification rules](#2-verification-rules)
3. [Storage](#3-storage)
4. [Double-spend prevention](#4-double-spend-prevention)
5. [Expiry](#5-expiry)
6. [Redemption](#6-redemption)
7. [Trust model](#7-trust-model)

Reference implementation: `packages/shared/src/x402.ts` (types), `voucher.ts` (signing, request hash), `headers.ts` (encoding); `packages/gateway/src/paywall/` (verification, ledger, forwarding, quality guard); `packages/gateway/src/settlement/` (redemption); `packages/gateway/src/disputes/` (disputes on the redeemed charge); `packages/agent/src/x402Client.ts` (client).

## Overview

| Term | Meaning |
|---|---|
| Tab | One PayPal hold (an Orders v2 `AUTHORIZE` order) owned by a company. All of the company's agents spend against it. |
| Channel | One (tab, seller) pair, with the sequence number and running total of the last voucher the gateway took. |
| Voucher | The commitment: an IOU for one request, signed with the agent's Ed25519 key. |
| Gateway | Serves the paywall at `/s/<sellerId>/<path>`, verifies vouchers, forwards paid requests to the seller, records the outcome and redeems the tab. In x402 terms it is both the resource server and the facilitator. |

The flow:

1. **Open a tab.** `POST /api/tabs` returns an `approveUrl` and an `enrollToken` (shown only in this response). The payer approves the hold on PayPal; PayPal redirects to the gateway, which authorizes the order and makes the tab `active`.
2. **Register agent keys.** `POST /api/tabs/{tabId}/keys` with `{ "agentId", "publicKey", "enrollToken" }`.
3. **Learn prices.** `GET /api/catalog` lists every seller, endpoint and price; `GET /api/config` gives `paypalMode`, so the network is `paypal:<paypalMode>`. A client that knows the price pays on the first request. Otherwise it calls without payment and reads the 402 quote.
4. **Pay per request.** The request carries `PAYMENT-SIGNATURE`. The gateway answers with the seller's response and `PAYMENT-RESPONSE`, or with 402 and `PAYMENT-REQUIRED`.
5. **Redeem.** The tab closes with one PayPal capture. Sellers are paid with PayPal Payouts. If the company disputes the capture on PayPal, the stored vouchers are the evidence ([Disputes](#disputes)).

Conventions:

- **Amounts** are decimal strings of integer micro-dollars (asset `USD`, 6 decimals; 1 USD = 1,000,000), matching `^(0|[1-9]\d{0,15})$`: no sign, no leading zeros, no decimal point. `"5000"` is $0.005. PayPal itself only ever sees whole cents.
- **Header values** are standard base64 (with padding) of UTF-8 JSON.
- **base64url** means RFC 4648 section 5 without padding.
- **Network** is `paypal:mock` or `paypal:sandbox`, whichever the gateway runs (`PAYPAL_MODE`). The type also reserves `paypal:live`, which this gateway does not serve.
- **A 402 never records anything.** The channel only advances when a voucher is accepted for forwarding, so after any 402 the next voucher reuses the same `seq` and `cumulative` unless the 402 says otherwise.

## Headers

### `PAYMENT-REQUIRED`

Sent with every 402: as the quote when a request carries no payment, and on every refused payment. The response body is the same JSON. Decoded, for an unpaid `POST /s/channel3/v1/search` on a mock-mode gateway:

```json
{
  "x402Version": 2,
  "error": "This call costs $0.005. Open a tab, then sign a batch-settlement voucher.",
  "resource": {
    "url": "http://localhost:4020/s/channel3/v1/search",
    "description": "Product search across merchants: text query, price filters, offers with live prices.",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "paypal:mock",
      "asset": "USD",
      "amount": "5000",
      "payTo": "channel3",
      "maxTimeoutSeconds": 300,
      "extra": {
        "decimals": 6,
        "endpointId": "ep_2m8q4x7c1v9b3n5k",
        "tabEndpoint": "http://localhost:4020/api/tabs",
        "catalogUrl": "http://localhost:4020/api/catalog",
        "voidRules": {
          "on5xx": true,
          "on4xx": true,
          "timeoutMs": 8000,
          "emptyIsBillable": false,
          "emptyResultPaths": ["products"],
          "requireJson": true
        },
        "reason": "payment_required",
        "message": "This call costs $0.005. Open a tab, then sign a batch-settlement voucher."
      }
    }
  ]
}
```

| Member | Meaning |
|---|---|
| `error` | The human-readable message, same as `extra.message`. |
| `resource.url` | The paywalled URL (`PUBLIC_BASE_URL` + `/s/<sellerId>` + path and query). |
| `accepts` | Always exactly one `PaymentRequirements`. |
| `amount` | The endpoint's current price in micro-dollars. It is always present, even in rejections. |
| `payTo` | The seller id. Money does not go to the seller directly (see [Trust model](#7-trust-model)). |
| `maxTimeoutSeconds` | The longest a voucher may live: `exp - iat <= 300`. |
| `extra.endpointId` | The matched endpoint. |
| `extra.tabEndpoint`, `extra.catalogUrl` | Where a company opens a tab, and where prices are listed. |
| `extra.voidRules` | The seller's published rules for responses that are not billable ([Void rules](#void-rules)). |
| `extra.reason` | Why the gateway answered 402 ([402 reasons](#402-reasons)). |
| `extra.expectedSeq`, `extra.expectedCumulative` | On `stale_sequence` and `amount_mismatch`: what the next voucher on this channel must carry. |
| `extra.retryAfterSec` | On `tab_paused` and `rate_limited`, also sent as the `Retry-After` header. |

A refused replay of the voucher in the next section looks like this (only `extra` shown):

```json
{
  "reason": "stale_sequence",
  "message": "Expected seq 4 with cumulative 17000, got seq 3 with 12000.",
  "expectedSeq": 4,
  "expectedCumulative": "17000"
}
```

### `PAYMENT-SIGNATURE`

Sent by the client with the paid request. Decoded, it is a `PaymentPayload`:

```json
{
  "x402Version": 2,
  "resource": { "url": "http://localhost:4020/s/channel3/v1/search" },
  "accepted": {
    "scheme": "batch-settlement",
    "network": "paypal:mock",
    "asset": "USD",
    "amount": "5000",
    "payTo": "channel3",
    "maxTimeoutSeconds": 300,
    "extra": {
      "decimals": 6,
      "endpointId": "ep_2m8q4x7c1v9b3n5k",
      "tabEndpoint": "http://localhost:4020/api/tabs",
      "catalogUrl": "http://localhost:4020/api/catalog",
      "voidRules": {
        "on5xx": true,
        "on4xx": true,
        "timeoutMs": 8000,
        "emptyIsBillable": false,
        "emptyResultPaths": ["products"],
        "requireJson": true
      }
    }
  },
  "payload": {
    "voucher": {
      "v": 1,
      "tab": "tab_k3x9q2m1v8p0w7ab",
      "seller": "channel3",
      "seq": 3,
      "price": "5000",
      "cumulative": "12000",
      "reqHash": "FQidXUbND8EDd7h4M-gyKTKKShQ95A_zgwvSJ6U3KJs",
      "agent": "agent_7f2kq9x1m3c8",
      "task": "run_0h5t2w8e4r6y1u3i",
      "iat": 1794297600,
      "exp": 1794297720,
      "nonce": "q6dS1y7m2kV9pW3xZ0bN4g"
    },
    "sig": "mHI8VbuL8wjtd-71yHWKdTkJDvQpTw40vM1VL1pJb-Uh3eqtiAftHzin34_nYjO1VTdlkg1H7lGeGuTEXk2kAg"
  }
}
```

The gateway checks `x402Version` (must be `2`), `accepted.scheme` and `accepted.network`. The other members of `accepted`, and `resource.url`, are informational: the reference client echoes the quote. The commitment is `payload`.

This is the agent's third call to Channel3 on the tab: a $0.005 search (seq 1, cumulative 5000), a $0.002 product lookup (seq 2, cumulative 7000), then this $0.005 search (seq 3, cumulative 12000).

### `PAYMENT-RESPONSE`

Sent with every response to a paid request, including the gateway's own 502 and 504 when the seller fails. Decoded, it is a `SettlementResponse`. Accepted:

```json
{
  "success": true,
  "scheme": "batch-settlement",
  "network": "paypal:mock",
  "transaction": "vch_5k2m9q1x7c3v8b0n",
  "status": "accepted",
  "amount": "5000",
  "cumulative": "12000"
}
```

Voided (here a ReviewPulse call at $0.003 that answered HTTP 500; the agent gets the seller's 500 response and pays nothing):

```json
{
  "success": false,
  "scheme": "batch-settlement",
  "network": "paypal:mock",
  "transaction": "vch_9w4e6r1t3y8u2i0o",
  "status": "voided",
  "amount": "0",
  "cumulative": "9000",
  "reason": "upstream_5xx"
}
```

| Member | Meaning |
|---|---|
| `transaction` | The voucher's id in the ledger. The seller received it as the `X-P402-Voucher` request header. |
| `status` | `accepted` or `voided`. |
| `amount` | Billable for this call: the price, or `"0"` when voided. |
| `cumulative` | The channel's running total including this call, voided calls included. Clients track it. |
| `reason` | The void reason, when voided. |

## 1. Commitment format

### 1.1 The voucher

A commitment is a `SignedVoucher`: `{ "voucher": Voucher, "sig": string }`.

| Member | Type | Rule |
|---|---|---|
| `v` | number | `1` |
| `tab` | string, 1 to 64 chars | The tab the IOU draws on. |
| `seller` | string, 1 to 64 chars | The seller id. Must equal the `<sellerId>` in the request URL. |
| `seq` | integer, 1 to 2^53 - 1 | Position on the (tab, seller) channel: the channel's previous `seq` + 1, starting at 1. All agents on a tab share the channel. |
| `price` | amount string | This call's price. Must equal the endpoint's current price (`accepts[0].amount`). |
| `cumulative` | amount string | The channel's running total including this call: the channel's previous `cumulative` + `price`. |
| `reqHash` | string, 1 to 128 chars | The request hash ([1.3](#13-request-hash)). |
| `agent` | string, 1 to 64 chars | The agent whose key is registered on the tab. Optional in the type, required by this gateway: a voucher without it fails with `invalid_signature`. |
| `task` | string, 1 to 128 chars, optional | A cost-attribution id the gateway stores with the call. The in-process agent uses its run id. |
| `iat` | integer, unix seconds | Issued at. |
| `exp` | integer, unix seconds | Expires at. `iat < exp <= iat + 300`. |
| `nonce` | string, 1 to 64 chars | Randomness so no two vouchers are identical. The reference client uses 16 random bytes, base64url (22 chars). |

No other members are allowed. The gateway parses the voucher with a strict schema and rejects unknown members (`invalid_voucher`), because the signature covers exactly these members. Optional members are omitted, never `null`.

### 1.2 The signed bytes

The signature covers the UTF-8 bytes of `canonicalJson(voucher)`:

- object keys sorted ascending by UTF-16 code unit (for these ASCII keys, plain byte order),
- no whitespace,
- members whose value is undefined dropped,
- strings and numbers written the way `JSON.stringify` writes them.

For a voucher with every member, the key order is therefore `agent, cumulative, exp, iat, nonce, price, reqHash, seller, seq, tab, task, v`.

The algorithm is Ed25519 (RFC 8032, pure, no prehash) with the agent's private key. `sig` is the 64-byte signature in base64url (86 chars). The gateway verifies the voucher exactly as received: it canonicalizes the parsed object again, so the member order on the wire doesn't matter.

### 1.3 Request hash

A voucher pays for one request only:

```
reqHash = base64url( SHA-256( METHOD + "\n" + pathWithQuery + "\n" + hex( SHA-256(body) ) ) )
```

- `METHOD` is the HTTP method in upper case. Endpoints are `GET` or `POST`.
- `pathWithQuery` is the raw request target after `/s/<sellerId>`, exactly as sent on the wire: the path plus the query string, with its original encoding and parameter order. `GET /s/pricewatch/v1/history/esp-1001?current_price=179.00` hashes `/v1/history/esp-1001?current_price=179.00`.
- `body` is the raw request body; `GET` requests have an empty body. The gateway hashes the bytes it received and forwards those same bytes to the seller.
- The body hash is lowercase hex; the result is base64url (43 chars).

### 1.4 Keys and enrollment

The agent's public key is the raw 32-byte Ed25519 key in base64url (43 chars), which is the `x` member of its JWK. Register it before paying:

```http
POST /api/tabs/tab_k3x9q2m1v8p0w7ab/keys
Content-Type: application/json

{ "agentId": "agent_7f2kq9x1m3c8", "publicKey": "HhwNDwb8PYC50pgVPO4iD2F6bhM9A7NDe1QAdjfmorY", "enrollToken": "tok_..." }
```

- `agentId` matches `^[A-Za-z0-9._:-]{1,64}$`.
- The enroll token comes from `POST /api/tabs` (`tok_` + 32 random bytes, base64url). The gateway stores only its SHA-256 and compares in constant time. A wrong token is `403 invalid_enroll_token`.
- Keys can be registered while the tab is `pending_approval`, `active` or `paused`. Registering the same key again is a no-op; a different key for an enrolled `agentId` is `409 agent_exists`.
- Agents started from the console run inside the gateway, which registers their keys directly.

### 1.5 Test vector

Produced with the reference functions in `packages/shared/src/voucher.ts`. Verifying `sig` with `publicKey` over the canonical bytes must succeed.

| Step | Value |
|---|---|
| Request | `POST /s/channel3/v1/search` with body `{"query":"espresso machine","limit":5}` |
| SHA-256(body), hex | `6ff24d0ef7f234cc01b0d965fbb7a852b93f371b8f2fc19906edb3852b5d283b` |
| Hash input | `POST` LF `/v1/search` LF `6ff24d0ef7f234cc01b0d965fbb7a852b93f371b8f2fc19906edb3852b5d283b` |
| `reqHash` | `FQidXUbND8EDd7h4M-gyKTKKShQ95A_zgwvSJ6U3KJs` |
| `publicKey` | `HhwNDwb8PYC50pgVPO4iD2F6bhM9A7NDe1QAdjfmorY` |
| `sig` | `mHI8VbuL8wjtd-71yHWKdTkJDvQpTw40vM1VL1pJb-Uh3eqtiAftHzin34_nYjO1VTdlkg1H7lGeGuTEXk2kAg` |

Canonical bytes (`iat` is 2026-11-10T08:00:00Z):

```
{"agent":"agent_7f2kq9x1m3c8","cumulative":"12000","exp":1794297720,"iat":1794297600,"nonce":"q6dS1y7m2kV9pW3xZ0bN4g","price":"5000","reqHash":"FQidXUbND8EDd7h4M-gyKTKKShQ95A_zgwvSJ6U3KJs","seller":"channel3","seq":3,"tab":"tab_k3x9q2m1v8p0w7ab","task":"run_0h5t2w8e4r6y1u3i","v":1}
```

For a request with no body, SHA-256 of the empty string is `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, so `GET /s/channel3/v1/products/esp-1001` has `reqHash` `HaQ2rgL4yTw-qnYJDAkjNtJYpuvYyQMwWalv4BO04cc`.

## 2. Verification rules

The gateway runs these checks in this order for every request to `/s/<sellerId>/<path>`. The first failure decides the answer.

**Routing, before any payment is looked at** (JSON `{ "error", "message" }`, no x402 headers):

| # | Check | On failure |
|---|---|---|
| R1 | Request body is at most 1 MB | `413 payload_too_large` |
| R2 | The seller is listed | `404 seller_not_found` |
| R3 | The seller is active | `503 seller_paused` |
| R4 | The path is safe (absolute, no backslashes, no empty, `.` or `..` segments, raw or percent-encoded, no encoded slashes) and (method, path) matches one of the seller's endpoints. Literal segments win over `:param` segments. | `404 endpoint_not_found` |

**Payment** (402 with `PAYMENT-REQUIRED`; nothing is recorded):

| # | Check | On failure (`extra.reason`) |
|---|---|---|
| V1 | `PAYMENT-SIGNATURE` is present and not empty | `payment_required`: the quote |
| V2 | The header is base64 UTF-8 JSON shaped like a `PaymentPayload`: `x402Version` is `2`, `resource.url` is a string up to 4,096 chars, `accepted.scheme` and `accepted.network` are strings, `payload.voucher` is an object, `payload.sig` is a string of 1 to 256 chars | `invalid_voucher` |
| V3 | `accepted.scheme` is `batch-settlement` | `invalid_voucher` |
| V4 | `accepted.network` is this gateway's network | `invalid_voucher` |
| V5 | The voucher passes the strict schema in [1.1](#11-the-voucher) | `invalid_voucher` |
| V6 | The tab exists | `tab_not_found` |
| V7 | The tab is `active` | `tab_paused` (with `retryAfterSec`: 5 s while an AI review runs, 30 s once it waits for a human), `tab_frozen`, or `tab_not_active` for any other status |
| V8 | The voucher names an `agent`, that agent has a key on this tab, and the Ed25519 signature verifies over the voucher as received | `invalid_signature` |
| V9 | `seller` is the URL's seller and `price` equals the endpoint's price | `amount_mismatch`, with `expectedSeq` and `expectedCumulative` for this channel at the correct price, which is in `accepts[0].amount` |
| V10 | Fresh, on the gateway's wall clock (a fast-forwarded demo clock does not count): `iat <= now + 30`, `exp > now`, and `0 < exp - iat <= 300` | `voucher_expired` |
| V11 | `reqHash` equals the hash of this request ([1.3](#13-request-hash)) | `invalid_voucher` |
| V12 | `cumulative` is a safe integer (at most 2^53 - 1) | `invalid_voucher` |

**Reservation**, in one SQLite transaction that ends by advancing the channel and inserting the voucher as `pending`:

| # | Check | On failure |
|---|---|---|
| V13 | `seq` is the channel's last `seq` + 1 and `cumulative` is its last cumulative + `price` (a new channel starts at 0 and 0) | `stale_sequence`, with `expectedSeq` and `expectedCumulative` |
| V14 | The policy allows this seller (`allowedSellers`, `*` for any) | `seller_not_allowed` |
| V15 | `price <= perCallMaxMicros` | `price_above_limit` |
| V16 | Today's committed spend + `price <= dailyCapMicros` (calendar day in UTC on the gateway clock; committed means accepted plus in flight) | `daily_cap_reached` |
| V17 | Committed spend on the tab + the carried-in remainder + `price` fits in the hold | `hold_exhausted` |
| V18 | Fewer than `maxCallsPerMinute` calls on the tab in the last 60 s (every status, in flight included) | `rate_limited`, with `retryAfterSec` |
| V19 | The insert succeeds against `UNIQUE (tab_id, seller_id, seq)` | `stale_sequence` |

V1 to V12 are synchronous and V13 to V19 run in one transaction on a synchronous SQLite driver, so within a gateway process nothing can interleave between verification and reservation.

After the reservation the gateway forwards the request, judges the response ([Void rules](#void-rules)), records the voucher as `accepted` or `voided`, and answers with the seller's status, body and content type plus `PAYMENT-RESPONSE`. When the seller times out the agent gets `504`; when it is unreachable or sends more than 2 MB, `502`. Both carry `PAYMENT-RESPONSE` with `status: "voided"`.

## 3. Storage

The gateway keeps the ledger in SQLite (WAL mode). Money is integer micro-dollars and times are epoch milliseconds on the gateway clock.

| Table | What it holds |
|---|---|
| `vouchers` | One row per reserved call: `id` (`vch_...`), tab, seller, endpoint, `seq`, `price_micros`, `cumulative_micros`, `req_hash`, method, path with query, agent, task, `status` (`pending`, then `accepted` or `voided`), void reason, HTTP status, latency, response size, a request excerpt (method, path and the first 500 chars of the body), a response excerpt (the first 2 KB), `signature`, review id, settlement id, created time. `UNIQUE (tab_id, seller_id, seq)`. |
| `channels` | Per (tab, seller): `last_seq` and `last_cumulative_micros`. |
| `agent_keys` | Per (tab, agent): the Ed25519 public key. |
| `events_log` | Append-only audit of every event except metrics snapshots (`voucher.accepted`, `voucher.voided`, `tab.updated`, `settlement.completed`, ...). |

- `signature` stores the `PAYMENT-SIGNATURE` header exactly as received; the nonce, `iat` and `exp` are kept only there. With `agent_keys`, any voucher can be verified again later, and the gateway does so for every billed voucher when the charge is disputed ([Disputes](#disputes)).
- A `pending` row exists only while its call is in flight. Pending rows are never billable, never returned by the API and never emitted as events, but they count against the hold, the daily cap and the rate limit.
- Pending rows left by a crash are voided at startup (`upstream_unreachable`). At close, rows still pending after the grace period are voided (`timeout`).
- Nothing is deleted. A billed voucher keeps its `settlement_id`, which links it to the one capture that paid for it.

The reference client keeps `(seq, cumulative)` per (gateway, tab, seller) in memory and updates it from `PAYMENT-RESPONSE.cumulative`. A client that loses that state recovers it from `stale_sequence` ([section 4](#4-double-spend-prevention)).

Sellers store nothing for the scheme. Each forwarded request carries `X-P402-Voucher: <voucher id>` so a seller can match its own request logs to the gateway's ledger.

## 4. Double-spend prevention

- **One sequence per channel.** A (tab, seller) channel accepts only `seq = last_seq + 1` with `cumulative = last_cumulative + price`. Replaying a captured header, even a fresh one, fails with `stale_sequence` because its `seq` is used.
- **Reserved before forwarding.** The sequence check, the policy checks, advancing the channel and inserting the voucher happen in one transaction before the seller sees the request. Two concurrent requests with the same `seq` produce exactly one forwarded call; the other gets `stale_sequence`. The gateway's tests check exactly that.
- **UNIQUE backstop.** `UNIQUE (tab_id, seller_id, seq)` on `vouchers` rejects a second voucher with the same position even if another writer shares the database.
- **Bound to one request.** `reqHash` ties the voucher to one method, path, query and body, and `tab` and `seller` are signed, so a voucher can't be moved to another request, tab or seller.
- **In-flight calls count.** Pending vouchers count against the hold, the daily cap and the rate limit, so parallel calls can't overspend.
- **Voids still use the position.** A voided call keeps its `seq` and its price stays in `cumulative` (the agent signed it), but it bills nothing.
- **Billing is the sum of accepted prices,** not the last `cumulative`. Since `cumulative` includes voided calls, the latest `cumulative` signed on a channel is an upper bound on what that channel can ever bill.
- **Resync.** `stale_sequence` (V13) and `amount_mismatch` carry `expectedSeq` and `expectedCumulative`. A client that restarted, or shares a tab with another process, sets its channel to `(expectedSeq - 1, expectedCumulative - price)` and signs again. Resyncing can't cause a double charge: each accepted voucher is billed once, at its own price. The rare V19 answer carries no expected values; sending the voucher again returns a regular `stale_sequence` that has them.
- **Client discipline.** The reference client serializes calls per channel inside a process, so its own agents never race for a sequence number.

## 5. Expiry

### Vouchers

- `iat` and `exp` are unix seconds, checked against the gateway's wall clock. In demo mode the gateway's clock may run days ahead; freshness ignores that offset, so agents always sign with real time.
- `iat` may be up to 30 s in the future (clock skew). `exp` must be in the future, and `exp - iat` must be between 1 and 300 s (`maxTimeoutSeconds`). The reference client signs with `exp = iat + 120`.
- An expired voucher was never recorded: sign a new one at the same `seq`.
- A voucher is only good while its tab is `active`. Once the tab is paused, frozen, closing or settled, new vouchers are refused (V7).

### The hold

The tab's PayPal authorization follows PayPal's rules: valid 29 days, honored 3 days, reauthorized at most once.

| When (from authorization) | What happens |
|---|---|
| Day 0 | PayPal authorizes the hold. `honor_until` = +3 days; `expires_at` = PayPal's `expiration_time`, or +29 days; `reauthorize_at` = +4 days; `close_at` = +`closeAfterDays` (7 by default). |
| Day 4 | Reauthorize once, for the hold amount. The new authorization gets a new 3-day honor window and keeps the original 29-day expiry. The capture then uses it. |
| Day 7 | The scheduled charge (redemption). |
| Any time | The tab closes as soon as billable spend plus the carried-in remainder reaches `closeAtCents` ($50 by default). |
| Small tab | If billable spend is under `smallTabMinCents` ($10) when the day-4 slot comes, the reauthorization moves to day 25 and the charge to day 28, never later than an hour before expiry. |
| Expiry minus 1 hour | A tab still open is closed (safety). |

The scheduler runs every 30 s, shortly after start, and right after the demo clock is moved forward; runs never overlap.

On `paypal:sandbox`, PayPal refuses a reauthorization inside the honor window, and a fast-forwarded demo clock can be days ahead of PayPal. The gateway therefore records the real time of each authorization and does not ask for a reauthorization until 3 real days have passed. A failed reauthorization is logged and retried at most hourly. In both cases the tab keeps its original authorization and is charged on schedule.

### What does not expire

The sub-cent remainder of a charge carries to the company's next tab (`carry_in_micros`), where it counts toward the hold and is billed with that tab. If the next tab is cancelled before PayPal approves it, the remainder goes back to the company. A hold that is never approved stays `pending_approval` until the payer cancels on PayPal or the company opens another hold, which cancels it.

## 6. Redemption

A tab is redeemed with one PayPal capture. Closing is triggered by:

- **manual:** `POST /api/tabs/{tabId}/close` (the console's "Close tab and charge" button),
- **threshold:** an accepted call brings billable spend plus carry-in to `closeAtCents`,
- **scheduled:** `close_at` is reached,
- **expiring:** one hour before the authorization expires.

Paused and frozen tabs are redeemed the same way. Steps:

1. Lock the tab and set it to `closing`. From here on, new vouchers get `tab_not_active`.
2. Wait for calls still in flight, up to the longest void-rule timeout among them plus 1 s.
3. In one transaction: void anything still pending (`timeout`); compute `billable` = the sum of `price` over the tab's accepted, unsettled vouchers plus `carry_in`; `charged_cents` = `floor(billable / 10,000)`, or 0 when no voucher earned anything; `carry_out` = `billable - charged_cents * 10,000`. Record a `pending` settlement and stamp each accepted voucher with its id.
4. On PayPal:
   - If `charged_cents` is 0, void the authorization. Nothing is captured.
   - Otherwise capture `charged_cents` on the current authorization (the reauthorization once there is one) with `final_capture: true`, `invoice_id` = the settlement id, `note_to_payer` "Agent API usage, N calls across K sellers", and `PayPal-Request-Id: capture-<settlement id>`. The fee is PayPal's `seller_receivable_breakdown.paypal_fee`; if PayPal leaves it out, the published rate of 3.49% + $0.49 is used. Then the gateway reads the authorization back, and if it still shows `CREATED` or `PARTIALLY_CAPTURED` it voids the rest, so nothing stays on hold.
5. In one transaction, write one line per seller and credit balances. With `w_s` the sum of seller `s`'s accepted prices:
   - `gross_s` = share of `charged_cents * 10,000` in proportion to `w_s`,
   - `fee_s` = share of `fee_cents * 10,000` in proportion to `w_s`,
   - `net_s` = `gross_s - fee_s`, credited to the seller's available balance.

   Shares use the largest-remainder method (ties broken by seller id), so the parts always add up exactly. The settlement becomes `completed`, the tab `settled`, and `carry_out` moves to the company.
6. If PayPal fails, the settlement is marked `failed`, the vouchers are released and the tab becomes `failed`. Closing it again retries. A crash during `closing` is resumed by the scheduler with the same `PayPal-Request-Id` and `invoice_id`, so the retry doesn't capture twice.

Ledger invariant for every completed settlement: the sum of `net` plus the sum of `fee` equals the sum of `gross`, which equals `charged_cents * 10,000`.

**Worked example** (computed with the gateway's settlement functions):

| Seller | Accepted calls | Sum of prices | Gross | Fee share | Net |
|---|---:|---:|---:|---:|---:|
| channel3 | 2,700 | $9.000000 | $8.996355 | $0.670717 | $8.325638 |
| pricewatch | 150 | $1.500000 | $1.499392 | $0.111786 | $1.387606 |
| reviews | 615 | $1.845000 | $1.844253 | $0.137497 | $1.706756 |
| **Total** | **3,465** | **$12.345000** | **$12.340000** | **$0.920000** | **$11.420000** |

Billable is $12.345, so PayPal captures $12.34 and $0.005 carries to the company's next tab. The fee at the published rate is $0.92 (7.46%). The same calls paid one by one would have cost $1,698.28 in fees.

**Invoice record.** With `PAYPAL_INVOICE_RECORDS=1`, a completed charge above $0 is also recorded in PayPal Invoicing v2 as a paid invoice: number `FIAT-<settlement id>`, billed to the payer of the hold, one line whose description lists each seller's calls and gross and the capture id. It is created as a draft (`PayPal-Request-Id: invoice-<settlement id>`), shared as a payer-view link rather than emailed, and marked paid. It is best effort: it never changes or delays the settlement, and the scheduler retries a failed record.

**Payouts.** `POST /api/payouts/run` with an optional `thresholdCents` (default 1000) pays every seller whose available balance, less what open disputes hold ([Disputes](#disputes)), is at least the threshold:

- amount = that payable balance floored to cents, minus the 25-cent Payouts fee; sellers left with nothing are skipped;
- the balances are debited (amount plus fee) in the same transaction that records the payout, before PayPal is called, so two runs can't pay twice;
- one Payouts batch: `sender_batch_id` = the payout id (also the `PayPal-Request-Id`), one `EMAIL` item per seller with `sender_item_id` = `<payout id>:<seller id>`, note "402 Fiatality weekly payout";
- the batch is polled briefly, then by the scheduler until it is final. Items PayPal fails, returns, blocks, refunds, reverses, denies or cancels give the amount and fee back to the seller.

### Disputes

The capture is an ordinary PayPal payment, so the company can dispute it on PayPal. The gateway reads disputes from the Disputes API v1 (every 2 minutes on `paypal:sandbox`, on every scheduler run on `paypal:mock`, or on demand) and links one to the tab when its disputed transaction (`seller_transaction_id`) is the settlement's `capture_id`. A dispute on any other capture is listed without a tab and changes nothing.

- **The commitments are the evidence.** For every billed voucher of the charge, the gateway decodes the stored `PAYMENT-SIGNATURE`, checks that the voucher's `tab` and `reqHash` match the ledger row, and verifies the Ed25519 signature with the key registered for its `agent` on that tab. An AI jury argues the case from these facts and drafts a response; a human sends it. Evidence carries a ledger summary after the response text, all within PayPal's 2,000 characters: the capture, each seller's calls and gross, how many billed calls verify against how many enrolled keys, up to three voucher ids with the start of each request hash, the voids and the spend reviews.
- **Hold.** While the dispute is unresolved, seller `s` has `floor(net_s × min(amount, charged_cents) / charged_cents)` held (nothing when `net_s` is zero or negative). Payouts pay the available balance less everything held.
- **Refund.** When PayPal resolves the dispute with money back to the buyer, the refunded cents (PayPal's figure, at most `charged_cents`) are split across the charge's sellers in proportion to `gross_s`, by the same largest-remainder method, and debited from their available balances. The dispute's `refund_applied_cents` advances in the same transaction that records each seller's part in `dispute_refunds`, so a refund PayPal reports again is never deducted twice, and a larger figure later is deducted as the difference.
- **Release.** A resolution in the seller's favour releases the hold and deducts nothing.

Settlement lines are never rewritten, so the ledger invariant above still holds, and for each dispute the sum of `dispute_refunds` equals `refund_applied_cents × 10,000`. The jury, the responses and the demo-only routes are described in [ARCHITECTURE.md](ARCHITECTURE.md#paypal-disputes-and-the-ai-jury).

## 7. Trust model

| Party | Trusts | For | Bounded by |
|---|---|---|---|
| Company | PayPal | Holding and capturing its funds | PayPal's authorization rules; one charge on its own account, which it can dispute like any PayPal payment. |
| Company | Gateway operator | Enforcing its policy, applying sellers' void rules, charging only accepted calls | The hold caps the charge. Every billed call is backed by a voucher only its agent could sign. The statement shows the charge, each seller's share, the voids and the fees, and every call stays in the ledger. |
| Company | Its agents | Spending sensibly | Policy limits, spend alarms, AI review, freezing. A leaked agent key can spend only within the tab's limits until the tab is frozen. |
| Seller | Gateway operator | Forwarding paid calls, collecting, paying out | Its own published void rules; the voucher id on every forwarded request; its earnings per settlement and payout (`GET /api/sellers/{id}/earnings`). In a dispute, only the disputed share of its net from that charge is held, and a refund comes off its balance in proportion to its gross on that charge, once. |
| Gateway | Agents | Authorizing each charge | Ed25519 signatures over the exact request, price and position. |
| Everyone | The AI reviewer | Judging alarms quickly | It can only resume, void accepted and unsettled calls of the paused tab, freeze that tab, or escalate. It cannot move money, change a policy or touch another tab. Below 0.6 confidence, on error or on timeout, a human decides. |
| Everyone | The AI dispute jury | Drafting the response to a dispute | It only recommends: a human sends every response, PayPal decides, and balances move only on PayPal's outcome. The buyer's message is untrusted evidence, never an instruction. |

What the signatures guarantee:

- Only keys registered on the tab, which needs the tab's enroll token, can create billable calls.
- Every billed call matches one signed voucher for that exact request, seller and price, and each voucher is billed at most once.
- On each channel, what can be billed never exceeds the latest signed `cumulative`.
- Any voucher can be checked again later from the stored header and the registered key. When the charge is disputed, the gateway checks every billed voucher this way, which shows that each billed call was authorized by a key enrolled on the company's own tab.

What they don't:

- Whether a response was good enough to pay for is judged by the gateway under the seller's published rules, and on alarms by the AI review or a human. The gateway keeps request and response excerpts and the review transcript as evidence, but the operator is trusted to apply the rules honestly. In a dispute the signatures prove authorization, not quality, and PayPal decides.
- Funds are held by the operator. The capture lands in the gateway's own PayPal account, which pays sellers through Payouts. PayPal orders with several payees require intent `CAPTURE` instead of `AUTHORIZE` and allow at most 10 purchase units, each a separate transaction with its own fee, so a shared hold has to settle into one clearing account. Disputes and refunds therefore land on that account too, and the gateway passes them to the sellers as in [Disputes](#disputes).
- A hold covers only earnings not yet paid out. A dispute that arrives after a payout leaves the seller's balance below zero once refunded, until later earnings cover it; the operator carries that gap meanwhile.
- Sellers see the forwarded request (allow-listed headers only, with their own API key injected by the gateway) and the voucher id. They never see the agent's signature or the company's PayPal details.

## Void rules

Each seller publishes `VoidRules` when it lists its API, and the gateway sends them in every quote's `extra.voidRules`:

| Rule | Default | Meaning |
|---|---|---|
| `on5xx` | `true` | Void when the seller answers 5xx. |
| `on4xx` | `true` | Void when the seller answers 4xx other than 402. |
| `timeoutMs` | `8000` | Void when there is no complete answer in this many ms (250 to 60,000). |
| `emptyIsBillable` | `false` | When false, empty answers are voided. |
| `emptyResultPaths` | `[]` | Dot paths to arrays that must not be empty, such as `["products"]`. |
| `requireJson` | `true` | Void a JSON-typed answer that doesn't parse. |

The quality guard applies them in this order; the first match voids the call:

| Condition | Void reason | Agent receives |
|---|---|---|
| No complete answer within `timeoutMs` | `timeout` | 504 from the gateway |
| Connection failed, was refused by the SSRF guard, or closed early | `upstream_unreachable` | 502 from the gateway |
| Answer larger than 2 MB (after decompression), or a compressed body that can't be decoded | `upstream_unreachable` | 502 from the gateway |
| Status 500 or above and `on5xx` | `upstream_5xx` | The seller's response |
| Status 400 to 499 except 402, and `on4xx` | `upstream_4xx` | The seller's response |
| JSON content type, non-empty body that doesn't parse, and `requireJson` | `malformed_json` | The seller's response |
| `emptyIsBillable` is false and the body is empty, `[]`, `{}` or `null`, or an `emptyResultPaths` array is empty | `empty_result` | The seller's response |
| The endpoint has a response JSON Schema and the body doesn't match it | `schema_mismatch` | The seller's response |

Anything else is accepted. A call can also be voided later, before its tab is redeemed:

- `ai_review`: the AI spend review (or a human deciding an escalated review) finds the seller at fault and voids those calls,
- `timeout`: the tab closed while the call was still in flight,
- `upstream_unreachable`: the gateway restarted mid-call.

## 402 reasons

| `extra.reason` | When | Extra members | What a client should do |
|---|---|---|---|
| `payment_required` | No `PAYMENT-SIGNATURE` | | Sign a voucher for `accepts[0]` and retry. |
| `invalid_voucher` | Header not decodable, wrong shape, scheme or network, voucher fails the schema, wrong `reqHash`, `cumulative` too large | | Fix the client. Retrying the same voucher won't help. |
| `tab_not_found` | No such tab | | Stop. |
| `tab_not_active` | Tab is `pending_approval`, `closing`, `settled`, `cancelled` or `failed` | | Stop; wait for approval or use a new tab. |
| `tab_paused` | An alarm paused the tab for review | `retryAfterSec`, `Retry-After` | Wait and retry with the same voucher position. |
| `tab_frozen` | The review or a human froze the tab | | Stop. |
| `invalid_signature` | No `agent`, agent not registered on the tab, or the signature doesn't verify | | Register the key, or fix signing. |
| `amount_mismatch` | Wrong seller in the voucher, or a price other than the endpoint's | `expectedSeq`, `expectedCumulative` | Re-sign at `accepts[0].amount`. |
| `voucher_expired` | Issued more than 30 s in the future, already expired, or living longer than 300 s | | Re-sign with the current time. |
| `stale_sequence` | Not the channel's next `seq` and `cumulative`, or the position was just taken | `expectedSeq`, `expectedCumulative` (except the UNIQUE backstop) | Resync and re-sign. |
| `seller_not_allowed` | The tab's policy excludes this seller | | Don't call this seller on this tab. |
| `price_above_limit` | Price over the per-call maximum | | Don't call this endpoint on this tab. |
| `daily_cap_reached` | Today's spending cap reached | | Wait for the next UTC day. |
| `hold_exhausted` | The call would exceed the PayPal hold | | Stop; the tab is spent. |
| `rate_limited` | Calls per minute at the policy's limit | `retryAfterSec`, `Retry-After` | Slow down. |

## Reference client

The behavior of `X402Client` in `packages/agent/src/x402Client.ts`, as guidance for other clients:

1. Read prices from `GET /api/catalog` and the network from `GET /api/config`, both cached. When the endpoint is known, pay on the first request: one round trip.
2. Otherwise send the request unpaid and take the 402 quote, after checking it: scheme `batch-settlement`, `payTo` equal to the seller in the URL, and a price above zero and no higher than the client's ceiling ($1 by default).
3. Keep `(seq, cumulative)` per (gateway, tab, seller), serialize calls per channel, and update the channel from each `PAYMENT-RESPONSE`.
4. On `stale_sequence`, resync from `expectedSeq` and `expectedCumulative`, then retry once. On `amount_mismatch`, take the price from `accepts[0].amount` (within the ceiling), then retry once.
5. On `tab_paused`, wait `Retry-After` seconds and retry, for at most 120 s in total per call.
6. Any other reason fails the call. The shopping agent ends its run on reasons about the tab (`tab_frozen`, `hold_exhausted`, a pause that outlasts the wait, ...), stops calling a seller after `seller_not_allowed` or `price_above_limit`, and moves on after other failures.
7. Never send a voucher to any origin other than the gateway's. A signed, unspent voucher buys its request for whoever presents it.
