# PayPal plan: purchase refunds and the SDK audit

Written with APIMatic's Context Plugin for the PayPal Server SDK (`paypal@context-plugins` 0.4.1:
`typescript-integrate-paypal`, `typescript-getting-started`, `typescript-error-handling`, `typescript-testing`).
Every wire fact below comes from the plugin's SDK map (`map/operations/payments.md`, `orders.md`,
`api-reference.md`, `src/models/*`) and was matched against the SDK this repo compiles against.

## Scope

1. `POST /api/purchases/:id/refund`: refund an agent's captured product purchase, in full or in part, through
   `PaymentsController.refundCapturedPayment`, idempotent with `PayPal-Request-Id`. Store each refund and its
   status. Show it on the Console purchase card (Refund purchase, a confirm step, then Refunded / Partly refunded)
   and on the statement. Mock mode simulates it.
2. Check every existing Orders and Payments SDK call against the plugin's guidance. Fix only real mismatches, each
   with a test.

## SDK, host and toolchain

| Fact | Value |
| --- | --- |
| SDK in this repo | `@paypal/paypal-server-sdk` 2.5.0, APIMatic-generated on `@apimatic/core`. The plugin maps APIMatic's regenerated build of the same PayPal spec (`paypal` 2.29.0, spec 2.29), so operations, wire names, defaults and error statuses match; only the TypeScript spelling differs (`new Client` + `PaymentsController`, `paypalRequestId`, `ApiResponse<T>`, `ApiError.statusCode`). Spellings checked in `dist/esm/types/controllers/paymentsController.d.ts:180` and `ordersController.d.ts:71`. |
| Client | Built once per process in `createSandboxPaypal` (`packages/gateway/src/paypal/sandbox.ts`); no new client. OAuth 2 client credentials come from our token source through `oAuthTokenProvider`; a 401 invalidates the cached token. |
| Host | `Environment.Sandbox` (https://api-m.sandbox.paypal.com) when `PAYPAL_MODE=sandbox`; `PAYPAL_MODE=mock` is the in-process mock. There is no live switch, and the sandbox client refuses to start without `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET`. |
| Retries | `defaultConfiguration.js`: `maxNumberOfRetries: 0`, so the SDK never repeats a call. Our own retries re-send the same `PayPal-Request-Id`. `new Client({...})` doesn't read the SDK's environment variables. |
| Logging | SDK logging stays off (not configured). `RefundRequest` holds no card or personal data; our logs carry ids, status, amount and `debug_id`, never a request body. |
| Pagination, streaming | None in scope. |
| `Error` model | Not imported. `PaypalError` here is ours (`paypal/errors.ts`), not the plugin SDK's family class. |
| Module format | ESM, `moduleResolution: Bundler`, `strict`, no `exactOptionalPropertyTypes`. Node 22.12+, run with tsx. |
| Commands | `npm run typecheck`, `npm test` (vitest), `npm run build`. Baseline at 96b80ec: typecheck clean, 390 tests pass. |

## Contract sheet

### `PaymentsController.refundCapturedPayment` (write)

- Wire: `POST /v2/payments/captures/{capture_id}/refund`, auth `oauth2`. Returns `Refund`.
- Request (flat object): `captureId` (path `capture_id`, required) · `paypalRequestId` (header `PayPal-Request-Id`,
  optional; PayPal stores keys for 45 days) · `prefer` (header `Prefer`, optional, default `return=minimal`, which
  returns only `id`, `status` and links) · `paypalAuthAssertion` (header, optional) · `paypalMockResponse` (header,
  optional) · `body: RefundRequest` (optional; an empty body refunds everything left).
- `RefundRequest`, every member optional: `amount: Money { currencyCode, value }`, `customId`, `invoiceId`,
  `noteToPayer`, `paymentInstruction` (platform partners only).
- `Refund`, every member optional, so assert on what we use: `id` (missing means unknown outcome), `status` (open enum
  `CANCELLED | FAILED | PENDING | COMPLETED`), `amount` (fall back to the amount we sent).
- Error statuses: 400, 401, 403, 404, 409, 422, 500, default.

### `OrdersController.getOrder` (read, the re-read for unknown outcomes)

- Wire: `GET /v2/checkout/orders/{id}`, auth `oauth2`. Returns `Order`.
- Request: `id` (path, required) · `fields` (query, optional; not sent) · `paypalMockResponse`, `paypalAuthAssertion`
  (headers, optional; not sent).
- `Order.purchaseUnits[].payments: PaymentCollection { authorizations?, captures?: OrdersCapture[], refunds?: Refund[] }`.
  Each `Refund` carries the `invoiceId` we sent.
- Error statuses: 401, 404, default.

## 1b.1 Durable writes

**DUPLICATE CLAIMS**

| Write | Where the claim is stored | What rejects the second one | Where that rejection is caught | Where in the code |
| --- | --- | --- | --- | --- |
| refundCapturedPayment | A `purchase_refunds` row in status `claimed`, inserted (and committed) before the SDK call | `UNIQUE (purchase_id, idempotency_key)`: the key the caller sends with the request (the Console mints one per confirm; API clients send their own), so a double click or a retry of the same refund computes the same key | `claimRefund` catches `SQLITE_CONSTRAINT_UNIQUE` (driver `code`) and returns the winner's row, which `answerAgain` answers with | `settlement/refunds.ts`: `claimRefund` inserts the claim; `send` calls `ctx.paypal.refundCapture` after it |

The claim's id is the reference sent on the wire: `PayPal-Request-Id` and `invoice_id` are both `refund-<claim id>`.
A repeat of a `claimed` or `unknown` claim re-sends the same request id, and PayPal answers with the refund it already
made. A refused (4xx) claim stays on record as `rejected`; a refusal that never left (credentials) releases the claim.

**UNKNOWN OUTCOMES**

| Write | The operation you re-read with | The reference you search by | Where in the code | The test that fails the connection |
| --- | --- | --- | --- | --- |
| refundCapturedPayment | `getOrder(purchase.paypal_order_id)` → `purchase_units[0].payments.refunds[]` | `invoice_id === refund-<claim id>` | `settlement/refunds.ts`: the `catch` in `send` calls `reread` | `refunds.test.ts` "settles a refund whose answer was lost by re-reading the order" (and "never re-reads a refund that was never sent, and lets the same key try again"); `sandbox.test.ts` "calls a lost answer unknown, and a token failure a refund that was never sent" |
| captureOrder (approvePurchase, audit fix) | `getOrder(orderId)` → `purchase_units[0].payments.captures[0]` | the order id (a CAPTURE order has one capture) | `settlement/purchases.ts`: the `catch` in `approvePurchase` calls `settleLostCapture` | `purchases.test.ts` "finds the capture by re-reading the order and records the purchase as paid" (and "does not re-read when PayPal refused the capture or it was never sent") |

Unknown means a `PaypalError` raised by the write itself with no usable answer: `TIMEOUT`, `NETWORK_ERROR`,
`INVALID_RESPONSE` (a 2xx we couldn't read) or a 5xx. A failure obtaining the OAuth token never sent the request,
so there's no re-read. When the re-read finds nothing, or fails, the outcome stays unknown, never failed.

## 1b.2 Cross-operation invariants

| Invariant | Where the legal set comes from | Enforced where | The test that proves it |
| --- | --- | --- | --- |
| Only a purchase this app captured can be refunded, and only its own capture | `purchases` rows with `status = 'captured'` and a `capture_id` | `claimRefund`, before the insert | "refuses a refund it may not make before asking PayPal": 409 `purchase_not_paid`, refundCapture not called |
| The refund fits what is left: amount ≤ captured − (completed + processing + pending + unknown refunds) | `purchases.amount_cents` and its `purchase_refunds` rows | `claimRefund`, in the claim's transaction, inside the purchase lock | Same test: 409 `refund_too_large`, refundCapture not called; "keeps a refund PayPal never confirmed as unknown, holds its amount…" |

## 1b.3 Optional request fields: refundCapturedPayment

| Field | What requires it | Set it? |
| --- | --- | --- |
| `body.amount` | The task ("a full or partial refund") and the claimed amount | ✅ Always the claimed amount (a full refund claims what is left), so the claim, the request and PayPal's own limit agree |
| `body.invoiceId` | The UNKNOWN OUTCOMES row (the reference we search by) | ✅ `refund-<claim id>` |
| `body.customId` | Nothing | ❌ |
| `body.noteToPayer` | Nothing | ❌ (`refundCapture` takes it as optional now and leaves it out when absent) |
| `body.paymentInstruction` | Nothing (platform partners only) | ❌ |
| `paypalRequestId` | The DUPLICATE CLAIMS row | ✅ `refund-<claim id>` |
| `prefer` | Storing PayPal's status and amount (minimal returns neither amount nor detail) | ✅ `return=representation` |
| `paypalAuthAssertion`, `paypalMockResponse` | Nothing | ❌ |

`getOrder`: no optional field is set.

## 1b.4 When the API says no: refundCapturedPayment

| Status | Our app answers | The caller reads | Test |
| --- | --- | --- | --- |
| 400 / 404 / 409 / 422 | The same 4xx (`refund_rejected`) | PayPal's reason (issue + description) | Fake 422 `REFUND_AMOUNT_EXCEEDED`; assert 422 and the reason |
| 401 / 403 | 502 `paypal_unavailable` | "PayPal refused our credentials. Nothing was refunded." | Fake 401; assert 502 and the fixed message |
| 429 | 503 `paypal_busy` | "PayPal is rate limiting us. Try again in a minute." | — |
| 5xx | Per UNKNOWN OUTCOMES | Settled if the re-read finds it, else unknown | Covered by the lost-answer test |
| No response | Per UNKNOWN OUTCOMES: 202 with the refund `unknown` | "PayPal didn't confirm the refund yet. Retrying with the same key is safe." | Lost-answer test |
| Token not obtained (never sent) | 502 `paypal_unavailable`, claim released | "PayPal refused our credentials. Nothing was refunded." | Never-sent test |

The re-read (`getOrder`) failing inside the unknown path leaves the claim `unknown` (202).

## Audit: existing SDK calls against the plugin's guidance

| Call (where) | Checked | Result |
| --- | --- | --- |
| `createOrder` AUTHORIZE hold (`holds.ts`), CAPTURE purchase (`purchases.ts`) | Body required ✓; `PayPal-Request-Id` derived from our ids ✓; `Prefer: return=representation` (we read links and units) ✓; no optional header we don't need ✓; text fields cut to PayPal's limits ✓ | OK |
| `getOrder` (return pages) | Only `id` sent ✓ | OK; now also maps `captures[0]` and `refunds[]` for the re-reads |
| `authorizeOrder` (`holds.ts`) | Optional body sent as `{}` (accepted) ✓; `authorize-<tab>` request id ✓; a failure leaves the tab pending, so a reload re-sends the same id ✓ | OK |
| `captureOrder` (`purchases.ts` approvePurchase) | A lost or unreadable answer (timeout, network, 5xx) was recorded as `failed`, though PayPal may have captured | **Fixed**: unknown outcome, settled by re-reading the order (or left awaiting approval, so a reload asks again); a refusal or a capture never sent still fails as before. The token is now fetched before the capture so the two can't be confused |
| `getAuthorizedPayment` (`close.ts`) | Only `authorizationId` ✓ | OK |
| `reauthorizePayment` (`scheduler.ts`) | Body carries only `amount` ("supports only the amount request parameter") ✓; `reauth-<tab>` ✓ | OK |
| `captureAuthorizedPayment` (`close.ts`) | `final_capture` defaults to false, so we send `true` explicitly ✓; `invoice_id` ≤ 127 ✓; `note_to_payer` non-empty ✓; `capture-<settlement>` ✓; the remainder is voided when PayPal still shows the hold open ✓ | OK |
| `voidPayment` (`close.ts`) | No body ✓; `Prefer: return=minimal` (we don't read the body) ✓; request id ✓; 404/422 read as "already released" ✓ | OK |
| `refundCapturedPayment` (`sandbox.ts`, unused until now) | `note_to_payer` was always sent, even empty, though nothing requires it; a missing `amount` in the answer was recorded as $0 | **Fixed** with the refund feature: note optional, amount falls back to the amount sent |
| 401 handling (`sandbox.ts` `call`) | A 401 invalidates the cached token and the next call re-acquires ✓ | OK |

## Assumptions and blockers

- No blockers. Minor assumption: PayPal's Orders GET lists a capture's refunds with the `invoice_id` we sent (the
  `PaymentCollection.refunds: Refund[]` model says so); the sandbox run confirms it.

## REQUIRED READING

- MUST load `typescript-error-handling`: unknown vs failed on writes, a caller's 4xx passes through with PayPal's
  reason, our credentials and quota become 5xx, assert on response members. (Loaded.)
- MUST load `typescript-testing`: fake at the transport seam (the axios adapter `sandbox.test.ts` already uses),
  assert the request the SDK actually built, cover the lost-answer and never-sent paths. (Load before the first test.)
- `typescript-client-initialization`: not triggered, since no client is constructed (the app-scoped client in
  `createSandboxPaypal` is reused).
