# Architecture

402 Fiatality is a TypeScript monorepo (npm workspaces, ESM, Node 22.12 or newer). A Fastify gateway owns the money: it serves the x402 paywall, keeps the voucher ledger in SQLite, enforces each tab's policy, raises spend alarms and runs the AI review, talks to PayPal, and brings PayPal disputes on its charges before an AI jury. A React app shows it all live over a WebSocket. Node packages run their TypeScript source directly through tsx; only the web app is built.

This document is for technical reviewers. The wire protocol is in [BINDING.md](BINDING.md); the original blueprint is [SPEC.md](SPEC.md).

## Packages

| Package | Owns | Main modules |
|---|---|---|
| `packages/shared` | The contracts every package uses: money math in integer micro-dollars and PayPal's fee functions, the x402 types, Ed25519 vouchers and the request hash, policies and void rules with their zod schemas, REST DTOs, event types. Node-only code (signing, header encoding) sits behind a separate entry point so the browser never loads it. | `money.ts`, `x402.ts`, `voucher.ts`, `headers.ts`, `policy.ts`, `voidRules.ts`, `api.ts`, `events.ts` |
| `packages/gateway` | The server: configuration, the dependency-injection context, the SQLite ledger, the event bus and `/ws`, the seller registry, the paywall, alarms, the review runner, in-process agent runs, both PayPal clients, settlement and invoice records, PayPal disputes, the REST API, metrics. | `src/config.ts`, `context.ts`, `services.ts`, `server.ts`, `core.ts`, `paywall/`, `sellers/`, `alarms/`, `review/`, `agents/`, `paypal/`, `settlement/`, `disputes/`, `routes/`, `db/`, `events/`, `ws.ts` |
| `packages/ai` | LLM clients (Ollama, OpenAI-compatible, offline mock) behind one interface, and the AI service: policy parsing, the spend review, the dispute jury, grid queries, the chat proxy. | `llm/`, `policy/`, `review/`, `dispute/`, `grid/`, `chat/`, `service.ts`, `scripts/check-llm.ts` |
| `packages/agent` | The x402 client and the shopping agent (modes llm, scripted, runaway), plus its CLI. | `x402Client.ts`, `session.ts`, `modes/`, `planner.ts`, `prompt.ts`, `cli.ts` |
| `packages/sellers` | Three demo seller APIs on one Fastify server, and their listings for the gateway's seeder. | `app.ts`, `channel3.ts`, `pricewatch.ts`, `reviews.ts`, `catalog.ts`, `demoSellers.ts` |
| `packages/web` | The React 19 + Vite dashboard. | `pages/`, `features/`, `components/`, `lib/` |

Internally the packages are scoped `@p402/*`. Dependencies point one way:

- Every package uses `packages/shared`; the web app imports only its browser-safe entry.
- The gateway's contracts (`PaypalClient`, `SettlementService`, `AiService`, `LlmClient`, `RunAgent`, the demo-seller functions) live in `packages/gateway/src/context.ts`. The ai, agent and sellers packages implement them and import them as types only. They also reuse the gateway's config loader for their CLIs and servers.
- The gateway imports the ai, agent and sellers implementations in one file, `src/services.ts`, the composition root; elsewhere it uses only two small helpers from the ai package (`warmUp` at startup, `isLlmError` in the AI routes). Everything else reaches them through the context, so tests swap in fakes.

## Processes and ports

| Process | Port | Started by |
|---|---|---|
| Gateway | 4020 | `npm run dev` (`tsx watch`), or `npm start`, which also serves the built web app |
| Demo sellers (`/channel3`, `/pricewatch`, `/reviews` on one server) | 4030 | `npm run dev`, `npm start` |
| Web app (Vite dev server) | 5173 | `npm run dev`; proxies `/api`, `/s/`, `/paypal` and `/ws` to the gateway |
| Ollama | 11434 | You, when `LLM_PROVIDER=ollama` |
| PayPal sandbox API | `api-m.sandbox.paypal.com` | Used when `PAYPAL_MODE=sandbox` |
| Channel3 API | `api.trychannel3.com` | Used when `CHANNEL3_API_KEY` is set |

## A paid call

```mermaid
sequenceDiagram
    autonumber
    participant A as Agent (X402Client)
    participant G as Gateway paywall
    participant DB as SQLite
    participant S as Seller API
    participant W as Web app over /ws
    A->>G: GET /api/catalog and /api/config (once, cached)
    A->>G: POST /s/channel3/v1/search with PAYMENT-SIGNATURE
    G->>DB: Find the seller and endpoint, load the tab and the agent key
    G->>G: Decode, check scheme and network, verify Ed25519, price, freshness, request hash
    G->>DB: One transaction: check seq and cumulative, policy limits, advance channel, insert voucher as pending
    G->>S: Forward the raw body with allow-listed headers, the seller key and the voucher id
    S-->>G: Response, within voidRules.timeoutMs and 2 MB
    G->>G: Quality guard applies the seller's void rules and response schema
    G->>DB: Voucher accepted or voided, with excerpts, status and latency
    G-->>W: voucher.accepted or voucher.voided
    G-->>A: Seller's status and body with PAYMENT-RESPONSE
    G->>G: After responding, run alarm detectors and the threshold close
```

The hot path makes no PayPal call. Verification and the reservation are synchronous (better-sqlite3), so nothing interleaves between checking a voucher's sequence number and recording it. The request body is kept as raw bytes: they are hashed for the voucher check and forwarded unchanged. Requests whose path tries to escape the seller's base path (dot segments, encoded slashes, backslashes) never match an endpoint. The full list of checks and their 402 reasons is in [BINDING.md, section 2](BINDING.md#2-verification-rules).

Agents started from the console run inside the gateway. Each run gets a fresh agent id and Ed25519 key pair; the public key is registered on the tab directly and the private key never leaves the process. The agent then pays through the public paywall over HTTP, exactly like an external agent started with `npm run agent`. At most three runs execute at once.

## Alarms, pause and AI review

After each judged voucher the gateway evaluates the tab's alarm rules from its policy:

| Alarm | Fires when (defaults) | Effect |
|---|---|---|
| `repeat_request` | The same request hash is paid for `repeatRequestThreshold` (5) times within `repeatWindowSec` (60 s) | Pause |
| `error_streak` | The last `errorStreak` (4) judged calls were all voided | Pause |
| `velocity` | Calls in the last minute reach 90% of `maxCallsPerMinute` (108 of 120) | Pause |
| `spend_spike` | Last-minute spend exceeds `spendSpikeMultiplier` (4) times the average per active minute of the 10 minutes before, given at least 3 active minutes in that baseline and at least $0.05 in the last minute | Pause |
| `budget_threshold` | Billable spend plus carry-in reaches `budgetWarnPct` (85%) of the hold | Notify only, once per tab |

Pausing detectors run in that priority order and only count calls made after the tab's previous pausing alarm, so the evidence behind one review can't trip the next alarm the moment the tab resumes.

```mermaid
flowchart TD
    voucher["Voucher judged"] --> detect{"Pausing alarm?"}
    detect -- no --> keep["Tab stays active"]
    detect -- yes --> pause["One transaction: tab active to paused, alarm inserted"]
    pause --> review["AI spend review: prosecutor, defender, judge"]
    review --> ruling{"Judge's ruling"}
    ruling -- resume --> active["Active"]
    ruling -- "void (seller fault)" --> voidcalls["Void the named calls, then active"]
    ruling -- "freeze (agent fault)" --> frozen["Frozen"]
    ruling -- "escalate: low confidence, error or timeout" --> human["Stays paused until a human decides"]
    human --> active
    human --> voidcalls
    human --> frozen
```

**The review runner** (`src/review/runner.ts`) allows one running review per tab. It gathers the evidence (the tab with its policy and totals, the alarm, the agent's task from the run behind the latest call, and the last 25 judged vouchers with their request and response excerpts) and calls `ai.reviewSpend`. Each role's message is saved to the review's transcript and emitted as `review.message` as it arrives, which is what the console banner and the terminal panel stream.

**In the AI service** (`packages/ai/src/review/`), the prosecutor and the defender each get the same two-part context, then their own turn, and are asked for at most 35 words. The judge answers in a JSON schema: verdict, fault, confidence, reason, voucher ids to void. Facts computed from the ledger (totals, limits, the most repeated request, seller failures) are marked trusted. Everything that came from agents or sellers sits inside an `<evidence>` block, flattened to single lines with angle brackets replaced, and the system prompt says it is never an instruction. The ruling is then checked: ids must come from the evidence; `void` must name at least one and mean seller fault; `freeze` means agent fault; a contradiction, confidence below 0.6, a model error or running out of the budget (`LLM_REVIEW_BUDGET_MS`, 45 s by default) becomes `escalate`. With `LLM_PROVIDER=mock`, deterministic rules play all three roles: loops and runaway pace freeze, seller failures behind an error streak are voided, anything else resumes.

**Applying the verdict** happens in one transaction with the review's final state:

- `resume`: the tab goes back to `active`.
- `void`: the named vouchers are voided with reason `ai_review` (only those of this tab that are accepted and not yet settled), then the tab resumes.
- `freeze`: the tab is `frozen`. Sellers keep payment for the calls they served well.
- `escalate`: the tab stays paused, the alarm stays open, and the AI's suggested voids are remembered for the human.

A human decides with `POST /api/reviews/{id}/decide` (`resume`, `void` or `freeze`), or with `POST /api/tabs/{id}/resume` and `/freeze`, which settle the pending review if there is one. While the tab is paused, agents get `402 tab_paused` with `Retry-After` of 5 s while the review runs and 30 s once it waits for a human. A review cut off by a shutdown or a crash is escalated to a human.

## Tab lifecycle and the settlement scheduler

```mermaid
stateDiagram-v2
    [*] --> pending_approval: POST /api/tabs creates the AUTHORIZE order
    pending_approval --> active: PayPal return, order authorized
    pending_approval --> cancelled: PayPal cancel, or a newer hold for the company
    active --> paused: pausing alarm
    paused --> active: resume or void verdict, or a human
    paused --> frozen: freeze verdict, or a human
    active --> frozen: a human freezes it
    frozen --> active: a human resumes it
    active --> closing: close
    paused --> closing: close
    frozen --> closing: close
    closing --> settled: one capture, or a void when nothing is billable
    closing --> failed: PayPal error
    failed --> closing: close again
    settled --> [*]
```

**Opening.** `POST /api/tabs` validates the policy, refuses a second open tab for the company (`409 tab_already_open`), creates the Orders v2 `AUTHORIZE` order (one purchase unit for the hold, `reference_id` and `custom_id` = tab id, description "Agent spending tab", soft descriptor "FIATALITY AGENT TAB", brand name "402 Fiatality", user action `CONTINUE`, no shipping) and stores the tab as `pending_approval` with a hashed enroll token and the company's carried remainder. Older unapproved tabs of the company are cancelled. The console opens PayPal's approval link in a popup.

**Approval.** PayPal redirects the popup to `GET /paypal/return?kind=tab&ref=<tab>&token=<order>`. The gateway checks that the token is the tab's own order, authorizes it, and sets `honor_until` (+3 days), `expires_at` (PayPal's `expiration_time`, or +29 days), `reauthorize_at` (+4 days) and `close_at` (+`closeAfterDays`). It answers with a small page under a strict nonce-based CSP that posts a message to the opener and closes itself. PayPal's pages can cut the popup off from its opener, so the console also treats the `tab.updated` event as the source of truth. `GET /paypal/cancel` cancels a tab that was never approved. Both are idempotent.

**The scheduler** (`src/settlement/scheduler.ts`) runs every 30 s, a second after start, and right after `POST /api/clock/advance`; runs never overlap. For each tab that is `active`, `paused`, `frozen` or `closing`, in order:

1. A tab left in `closing` by a crash: resume its pending settlement.
2. Billable spend plus carry-in at or above `closeAtCents` ($50): close it (threshold).
3. Within an hour of the authorization's expiry: close it (expiring).
4. Reauthorization due and not done yet:
   - a small tab (under `smallTabMinCents`, $10) on its day-4 slot: move the reauthorization to day 25 and the charge to day 28, then look again;
   - otherwise, unless the charge is due anyway: reauthorize for the hold amount, store the new authorization id and a new 3-day honor window.
5. `close_at` reached: close it (scheduled).

Then it refreshes payouts that PayPal is still processing, retries invoice records, and runs the hooks other modules register with `onSettlementTick`: the PayPal dispute sync ([below](#paypal-disputes-and-the-ai-jury)). Accepted calls that bring a tab to its threshold also trigger a close immediately, without waiting for the next run.

In sandbox mode the scheduler remembers the real time of each authorization and does not ask PayPal to reauthorize until 3 real days have passed, because PayPal refuses a reauthorization inside the honor window and the demo clock may be days ahead. A failed reauthorization is retried at most hourly. Either way the tab keeps its original authorization and is charged on schedule.

**Closing** (`src/settlement/close.ts`) takes a per-tab lock, sets `closing`, waits for calls in flight (up to the longest seller timeout plus 1 s), voids whatever is still pending, and records a pending settlement with the floored charge and the sub-cent carry. Outside any transaction it captures once with `final_capture` (or voids the hold when the charge is $0) and voids any remainder PayPal still shows. A final transaction writes the per-seller lines with the pro-rata fee split, credits seller balances, settles the tab and parks the carry for the company's next tab. On a PayPal failure the tab becomes `failed` with its vouchers unsettled, and closing again retries with the same `PayPal-Request-Id`. The exact algorithm and a worked example are in [BINDING.md, section 6](BINDING.md#6-redemption).

**Invoice records** (`src/settlement/invoices.ts`) are on with `PAYPAL_INVOICE_RECORDS=1`. After a charge above $0 the gateway records it in PayPal Invoicing v2 in the background: invoice number `FIAT-<settlement id>` (PayPal's 25-character limit), reference the tab, invoicer "402 Fiatality", recipient the payer of the hold when the order reports their email, and one line, "Agent API usage", whose description lists each seller's calls and gross and the capture id. The draft is created with `PayPal-Request-Id: invoice-<settlement id>`, sent with `send_to_recipient: false` (a payer-view link rather than an email, since the charge is already paid), and the payment is recorded against it with a note naming the capture. A draft left by an earlier attempt is found by its number and finished. The record never fails or delays the settlement: a failure is logged, and after each scheduler run up to 5 completed charges without a paid invoice are tried again, each at most every 5 real minutes. Charges settled before the setting was turned on are picked up the same way, newest first. The statement shows the invoice number, its status and PayPal's link.

**Payouts** (`src/settlement/payouts.ts`) run on `POST /api/payouts/run`, the Sellers page's "Run payouts" button. A seller is paid its available balance minus what open disputes hold ([below](#paypal-disputes-and-the-ai-jury)), when that is at least the threshold ($10 by default; the demo UI offers $1 and $0.10). Sellers are debited before PayPal is called, paid in one Payouts batch whose `sender_batch_id` is the payout id, and given their money back for any item PayPal fails. There is no automatic weekly job yet.

**Purchases** (`src/settlement/purchases.ts`) are separate from the tab. The agent files a proposal with `POST /api/purchases` (title, price, merchant, product link, image, research cost, reasoning). "Approve purchase with PayPal" calls `POST /api/purchases/{id}/checkout`, which creates an Orders v2 `CAPTURE` order with one item and user action `PAY_NOW`. After approval, `/paypal/return?kind=purchase` captures it and the purchase becomes `captured`.

**Every PayPal call that moves money through Orders, Payments or Payouts** sends a `PayPal-Request-Id` derived from our own ids (`hold-<tab>`, `authorize-<tab>`, `reauth-<tab>`, `capture-<settlement>`, `void-rest-<settlement>`, `void-<settlement>` for a $0 close, `checkout-<purchase>`, the payout id), so retries are idempotent; so does the invoice draft (`invoice-<settlement>`), and the client's capture refund takes one from its caller. Dispute actions send none: each is sent once per request, recorded on the dispute with PayPal's answer, and never retried automatically. Failures become a typed `PaypalError` (HTTP 502 `paypal_error`) carrying PayPal's error name, `debug_id` and issues.

**PayPal clients** (`src/paypal/`): the sandbox client uses the Server SDK's `OrdersController` and `PaymentsController` with `Prefer: return=representation` (so captures report `seller_receivable_breakdown.paypal_fee`), including the capture refund, and plain REST for Payouts v1, Disputes v1 and Invoicing v2, which are not in the SDK. One OAuth token cache serves both, and the client secret lives only inside that cache's closure. Dispute evidence goes as `multipart/form-data` with one `input` part of JSON (the shape of PayPal's documented `curl -F`); offers, escalation and adjudication go as JSON; messages and accepting a claim are retried in the other encoding once, only when PayPal rejects the encoding itself. Dispute responses are read tolerantly: the disputed capture ids, the buyer's latest message, the seller's deadline, the outcome, the money given back to the buyer, and the actions PayPal allows now (from its HATEOAS links).

The mock client implements the same interface offline and keeps its orders, authorizations, captures, batches, disputes and invoices in the `kv` table so they survive restarts. It enforces PayPal's rules: approval before authorization, one reauthorization after the honor window, expiry at 29 days, captures capped at 115% of the hold or +$75 (whichever is less), refunds capped at what is left of a capture, duplicate invoice ids rejected, and repeated request ids answered with the first result. Its disputes follow PayPal's lifecycle on the demo clock (next section), and its invoices are `MOCK-INV-...`, marked as paid, with no link.

## PayPal disputes and the AI jury

The company can dispute its one tab charge on PayPal like any other payment. `src/disputes/` brings those disputes into the ledger, holds the sellers' share while one is open, has the AI jury draft a response for a human to send, and applies PayPal's outcome to seller balances. The service is created once per context (`disputesOf(ctx)`), so the routes, the scheduler hook and shutdown share one jury runner.

```mermaid
flowchart TD
    opened["The buyer opens a dispute on the tab charge"] --> sync["Sync: every 2 min in sandbox, every scheduler run in mock, or on demand"]
    sync --> linked{"Disputed capture id is a settlement's capture?"}
    linked -- no --> unlinked["Listed without a tab: no hold, no jury"]
    linked -- yes --> hold["Hold each seller's net from that charge, pro rata"]
    hold --> jury["AI jury: prosecutor, defender, judge"]
    jury --> human["A human edits the draft and sends evidence, an offer or acceptance"]
    human --> outcome{"PayPal resolves it: money back to the buyer?"}
    outcome -- yes --> refund["Deduct the refund from the sellers pro rata by gross, once, and release the hold"]
    outcome -- no --> release["Release the hold"]
```

**Sync** (`disputes/index.ts`). In sandbox, `listDisputes` asks for disputes updated since a cursor kept in `kv`, less 10 minutes of overlap (the first sync takes PayPal's last 180 days). Each new or changed dispute is then fetched in full and upserted in one transaction. A dispute is linked to a tab charge when one of its `disputed_transactions[].seller_transaction_id` is a settlement's `capture_id`; disputes on the merchant's other captures are listed without a tab and touch no balances. The sync runs as a hook after each scheduler run: in sandbox at most every 2 real minutes, in mock on every run (every 30 s and after `POST /api/clock/advance`), because the demo clock ages mock disputes. `POST /api/disputes/sync` runs it at once; with `{"disputeId": "PP-R-..."}` it reads just that case, because PayPal's search can take minutes to list a new sandbox case while reading it by ID already works. The gateway polls instead of taking webhooks, so it needs no public URL.

**The jury** (`packages/ai/src/dispute/`, `AiService.reviewDispute`). A new linked dispute that is not already resolved starts a hearing; `POST /api/disputes/{id}/jury` starts one by hand or runs it again. The facts come from the ledger (`disputes/ledger.ts`): the charge and its capture, each seller's calls and gross, the tab's voids by reason, its spend reviews and their verdicts, billed calls that repeated an identical earlier request, and the signature check. For every billed voucher of the charge the gateway decodes the stored `PAYMENT-SIGNATURE`, checks that the voucher's `tab` and `reqHash` match the ledger row, and verifies its Ed25519 signature with the key its `agent` enrolled on the company's own tab. That count (for example, 246 of 246 billed calls) is the non-repudiation evidence. The buyer's message is the only untrusted input: it sits in an `<evidence>` block, flattened to one line with its angle brackets replaced and cut to 600 characters, and the system prompt says it is never an instruction.

The prosecutor argues the buyer's claim and the defender argues the charge stands on the signed ledger, each asked for at most 35 words; the judge answers in a JSON schema with `recommendation` (`contest`, `partial_refund` or `accept`), `refundCents`, `confidence`, `reason` and `draft`, the note for PayPal. The refund is made to agree with the recommendation: nothing for `contest`, 1 cent up to the amount less 1 for `partial_refund`, the disputed amount for `accept` unless a smaller refund was named. Each message is saved on the dispute and emitted as `dispute.message`.

The hearing has `LLM_REVIEW_BUDGET_MS`. A model error or running out of that budget marks it `failed` and keeps the ledger rules' recommendation and draft for the human; if no answer arrives even 5 s after the budget, the gateway marks it failed without one. With `LLM_PROVIDER=mock` those rules play all three roles: at least half of the tab's calls voided means accept; a runaway frozen by a spend review, with repeated calls, means refunding the repeats as goodwill; anything else is contested, 90% sure for an unauthorised claim when every billed call verifies, 80% for other reasons, 62% when some don't.

**Responses** (`POST /api/disputes/{id}/actions`). The jury never acts on its own; a human sends one of:

- `send_evidence`: the response text (the human's note, else the jury's draft when it recommended contesting, else a stock sentence) followed by a compact ledger summary (the capture, each seller's calls and gross, how many billed calls carry a valid signature from how many enrolled keys, voids, spend reviews), cut to PayPal's 2,000 characters. It goes as `provide-evidence` when PayPal takes evidence, otherwise as `send-message` on an inquiry. The evidence type is the one PayPal requested from the seller (the case's `evidences[]` with source `REQUESTED_FROM_SELLER`, for example `PROOF_OF_FULFILLMENT` on a not-received inquiry), read just before sending, else `OTHER`: PayPal refuses any other type.
- `make_offer`: a refund offer (`offer_type` `REFUND`) of `amountCents`, or the jury's refund. PayPal takes offers only on inquiries.
- `accept_claim`: refund the disputed amount, or `amountCents` as a partial refund.

The amount must be between 1 cent and the disputed amount, a resolved dispute answers `409 dispute_resolved`, and evidence PayPal won't take now answers `409 evidence_not_accepted`. Each attempt is appended to the dispute's `actions` with PayPal's answer. A PayPal failure also answers 502; after a success the dispute is read back from PayPal.

**Demo-only routes.** `POST /api/disputes/{id}/adjudicate` with `{"outcome": "buyer" | "seller"}` needs `DEMO_MODE=1`: with mock PayPal it settles at once. In the sandbox it first reads the case: PayPal rules only on a claim under its review that offers an `adjudicate` link. An inquiry that can still be escalated is escalated to a claim instead (recorded as an `escalate` action); PayPal then asks the seller to answer the claim, a few minutes later, and reviews it. Any other state answers `409 ruling_not_offered` with what PayPal is waiting for, and an accepted claim answers `409 claim_accepted` because PayPal closes it on its own. `POST /api/disputes/mock` exists only with mock PayPal: the buyer opens a dispute on a settled charge, by default for all of it with reason `MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED`. Both pass the admin guard like every `/api` write.

**Money rules** (`disputes/store.ts`, `db/dto.ts`). Holds are computed from the open disputes whenever balances are shown or paid out; refunds are applied inside the upsert's transaction.

- While a linked dispute is unresolved, each seller on that charge has `floor(net × min(amount, charged) ÷ charged)` held. Payouts pay the available balance minus everything held, and `SellerDTO.heldMicros` and `DisputeDTO.heldMicros` report it. A zero or negative net holds nothing, so on a tab of a few cents the hold is $0.
- When PayPal resolves it with money back to the buyer, the amount comes from PayPal's data: `dispute_outcome.amount_refunded`, else the seller's `DISPUTE_SETTLEMENT` debits in `money_movements`, else `refund_details`; for `RESOLVED_BUYER_FAVOUR` or `ACCEPTED` with no figure, the disputed amount; never more than the charge. Those cents are split across the charge's sellers in proportion to their gross (largest remainder) and debited from their available balances, which can go below zero.
- `refund_applied_cents` advances in the same transaction that adds each seller's part to `dispute_refunds`, so a refund PayPal reports again is never deducted twice, and a later increase is deducted as the difference.
- A resolution in the seller's favour releases the hold and deducts nothing.
- Settlement lines are never rewritten, so the settlement invariant still holds, and for each dispute the sum of `dispute_refunds` equals `refund_applied_cents × 10,000`.

**The mock lifecycle** (`paypal/mock.ts`). A mock dispute opens as an inquiry waiting for the seller, who has 10 days on the demo clock to respond before it resolves in the buyer's favour. Evidence puts it under review, a message waits for the buyer, an offer is accepted by the mock buyer at once, and accepting the claim or adjudicating settles it. A charge can have one open dispute at a time, for at most what is left of it.

**Recovery.** A hearing interrupted by a shutdown or a crash is marked failed (at shutdown, or at the next startup) so a human can run it again.

## Data model

SQLite through better-sqlite3, one file (`data/p402.sqlite` by default) in WAL mode with foreign keys on. Money columns are integer micro-dollars unless the name ends in `_cents`; times are epoch milliseconds on the gateway clock. Every multi-row write runs in a transaction and every statement is parameterized and cached per connection. The schema (`src/db/schema.sql`) is versioned with `PRAGMA user_version` and is at version 2. `openDb` upgrades an older database in place, in one transaction: it runs each migration step above the database's version, then the idempotent `schema.sql`, then sets the version. Version 2 only added tables (`disputes`, `dispute_refunds`, `invoices`), so a v1 database keeps all its data and needs no step code. Only a database from a newer build is refused, with instructions.

| Table | Holds | Notes |
|---|---|---|
| `companies` | Buyer companies | The demo seeds "Northwind Research". |
| `sellers` | Listings: base URL, auth header, encrypted API key, PayPal email, void rules, status | Keys are AES-256-GCM, `iv.tag.ciphertext`, never returned. |
| `endpoints` | Method, path pattern, price, description, optional response schema | `UNIQUE (seller_id, method, path)`; never deleted, because vouchers reference them. |
| `tabs` | Status, policy and its plain-English source, hold, enroll token hash, PayPal order and authorization ids, approval link, `authorized_at`, `honor_until`, `expires_at`, `reauthorize_at`, `reauthorized_at`, reauthorization id, `close_at`, `carry_in_micros` | One open tab per company. |
| `agent_keys` | Ed25519 public key per (tab, agent) | |
| `channels` | `last_seq` and `last_cumulative_micros` per (tab, seller) | The double-spend state. |
| `vouchers` | One row per paid call: sequence, price, cumulative, request hash, method, path, agent, task, status, void reason, HTTP status, latency, size, request and response excerpts, the signed header as received, review id, settlement id | `UNIQUE (tab_id, seller_id, seq)`; indexed by tab and time, by seller and settlement, and by tab and request hash for the loop detector. |
| `alarms` | Kind, message, detail, status (`open`, `reviewing`, `resolved`) | |
| `reviews` | Status, verdict, fault, confidence, reason, voided ids, transcript, model, decided by AI or human | |
| `settlements` | Billable, charged cents, carry-out, PayPal fee, capture id, the fee per-call payments would have cost, call and void counts | |
| `settlement_lines` | Per seller: gross, fee share, net, calls | Sum of net plus fee share = charged cents x 10,000. |
| `seller_balances` | Available and paid-out micro-dollars | Available can go below zero after tiny tabs, or after a dispute refund that lands once the seller was paid out. What open disputes hold is computed, not stored. |
| `payouts`, `payout_items` | Batches and their items, with PayPal batch and item ids and statuses | |
| `disputes` | PayPal's dispute id; the linked settlement, tab, company and capture; status, reason, stage, amount, outcome; refunded and refund-applied cents; the buyer's latest message; the seller's deadline; the actions PayPal allows now; the jury (JSON); the actions sent (JSON) | Unlinked disputes keep null ids and touch no balances. |
| `dispute_refunds` | Per (dispute, seller): what the seller gave back | Written in the transaction that advances `refund_applied_cents`. |
| `invoices` | Per settlement: PayPal's invoice id, number, status, amount, payer-view URL | `UNIQUE (settlement_id)`. |
| `purchases` | Agent proposals and their PayPal order, approval link, capture id, research cost | |
| `agent_runs`, `agent_steps` | Each in-process run and every step it reported | |
| `events_log` | Append-only audit of every event except metrics snapshots | |
| `kv` | Small state: the demo clock offset, each company's pending carry, the key-vault fingerprint, the real authorization time and reauthorization back-off per tab, an escalated review's suggested voids, the dispute sync cursor, the last failed invoice attempt per charge, and the mock PayPal's records (disputes and invoices included) | |

A voucher is `pending` only while its call is in flight: it counts toward limits but is never billable, listed or emitted, and any left over from a crash are voided at startup. Reviews interrupted by a restart are escalated to a human, interrupted agent runs and dispute hearings are marked failed.

## Events and the WebSocket

`src/events/bus.ts` is a typed in-process emitter for the `GatewayEvent` union in `packages/shared/src/events.ts`. Every emit is stamped with the gateway clock, appended to `events_log` (except `metrics`) and delivered to subscribers synchronously.

| Event | Emitted when |
|---|---|
| `voucher.accepted`, `voucher.voided` | A paid call is judged; `voucher.voided` also when a review voids an accepted call |
| `tab.updated` | Any change to a tab: created, approved, cancelled, paused, resumed, frozen, reauthorized, rescheduled, closing, settled, failed |
| `alarm.raised` | A detector fires |
| `review.started`, `review.message`, `review.finished` | The AI spend review, one message per role |
| `settlement.completed` | A tab settles |
| `payout.completed` | A payout batch reaches a final state |
| `seller.updated` | A listing, status, price or balance changes, including a dispute hold or refund |
| `agent.step`, `agent.finished` | In-process agent runs |
| `purchase.updated` | A proposal, checkout, capture or cancellation |
| `dispute.updated` | A dispute arrives or changes: PayPal's status, the jury's state, an action sent |
| `dispute.message` | The dispute jury, one message per role |
| `clock.advanced` | The demo clock moved |
| `metrics` | A summary of calls, billable, voids, fees, payouts, open alarms |

`/ws` (`src/ws.ts`) accepts browsers only from the web app's origin, the gateway's own, or localhost in demo mode. Each event is serialized once and sent to every socket. A `metrics` snapshot goes out on connect, then at most once a second and only when something changed. A client more than 4 MB behind is dropped rather than buffered without bound, and inbound messages are capped at 4 KB.

## The web app

| Route | Page | Built on |
|---|---|---|
| `/` | Landing: the hero as an `HTTP/1.1 402 Fiatality` response line with an IOU tape, how it works, the fee math, a section for sellers, the stack | Plain React and CSS; figures come from the shared fee functions |
| `/console` | Buyer console: 1 Company, 2 Budget ("Draft policy", editable policy card), 3 Hold ("Approve hold with PayPal"), 4 Run an agent (modes Gemma 4, Scripted, Runaway), 5 Approve the purchase, 6 Close the tab; a live tab card, the review banner, and the CLI command for running your own agent. `?tab=<id>` selects a tab. | |
| `/terminal` | Clearing terminal: stat strip, "Ask the ledger", the live IOU grid, settlements and payouts grids, seller pulse sparklines, the AI review panel and alarms, one-click Excel export of all three grids, and an "open disputes" pill when any are open | AG Grid Enterprise with the AI Toolkit |
| `/jury` | The AI jury's docket, newest first: rogue-agent reports from spend reviews and PayPal dispute cases. "The record" strip (one mark per case, colored by outcome; it doubles as legend and navigation), filter chips (All, Rogue agents, Disputes, Open; `?show=`), and each case's ruling and debate. A dispute case adds PayPal's facts, what is held from sellers, the jury's recommendation, an editable response with Send evidence, Offer refund and Accept claim behind a confirm step, the log of what was sent, and in demo mode a "Sandbox simulation" box (Rule for buyer, Rule for seller). "Sync with PayPal", and "Simulate a dispute" in mock mode. `/jury#<case id>` opens a case; the console links there when an agent is frozen, as do statements, Sellers and the terminal. Debates stream in live. | |
| `/sellers` | Seller portal: totals including what is held for disputes, seller cards with prices, balances, holds and void rates, "List your API", payouts and their history | |
| `/insights` | Spend by seller and voids by reason over a chosen range; fee rate by tab size and per-call vs batched fees; "Explore the ledger" in AG Studio with its AI assistant on Gemma | AG Charts, AG Studio |
| `/timeline` | Every tab's hold on one schedule against the demo clock, with drag-to-reschedule and a "+1 day" fast-forward in demo mode | Bryntum Scheduler |
| `/statements/:tabId` | A printable statement: the charge, fees against per-call payments, the per-seller split, PayPal disputes on the charge with the jury's recommendation, and the PayPal references, including the paid invoice when one was recorded | |

Each page is a lazily loaded route, so AG Grid, AG Studio and Bryntum load only with the pages that use them. The data layer lives in `src/lib`:

- `api.ts`: a typed client for every route, throwing `ApiError` (status 0 means the gateway is down). Writes send the admin header when an admin token is stored in the browser; the demo needs none.
- `events.ts`: one shared WebSocket with automatic reconnect, and hooks to subscribe by event type, read the latest event of a type, and refetch after a reconnect (missed events are not replayed).
- `resource.ts`: loading and error state with abort on unmount; live events patch the loaded data in place.
- `config.ts`: `/api/config` and `/api/health`, fetched once and shared; the header's PayPal-mode and model badges come from here.
- `paypal.ts`: opens the PayPal popup inside the click handler so browsers don't block it, then listens for the return page's message from the gateway's origin only.
- `format.ts`: money and time formatting, re-exporting the shared money functions.

The terminal never routes vouchers through React state: they go straight into AG Grid with `applyTransactionAsync`, batched and deduplicated by id. "Ask the ledger" sends `getStructuredSchema()` and `getState()` to `POST /api/ai/grid-query` and applies only the filter, sort, grouping, aggregation and column-visibility sections of the answer, with column ids checked first.

The design system (`src/styles/tokens.css`, `src/components`) uses CSS variables for light and dark themes, Hanken Grotesk and JetBrains Mono, hairline borders and one brass accent; the brand is a receipt-slip mark beside "402 Fiatality" in an arcade pixel face. The nav groups the pages by role (Buyer: Console · Seller: Sellers · Operator: Terminal, Jury, Insights, Timeline), and each route's `handle.role` puts a "Viewing as …" line above its page. It deliberately uses no PayPal logo or brand colors; PayPal's own pages are used only for approvals. License keys for AG Grid, AG Studio and Bryntum are optional `VITE_*` values read from the repo's `.env`.

## Configuration and the composition root

`src/config.ts` loads the root `.env` with Node's `process.loadEnvFile` (variables already in the shell win) and validates it with zod. Errors name the bad keys, never their values. Sandbox mode without PayPal credentials, or `DEMO_MODE=0` without `ADMIN_TOKEN`, refuses to start.

| Variable | Default | Purpose |
|---|---|---|
| `PAYPAL_MODE` | `mock` | `mock` or `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | | Sandbox REST app credentials |
| `PAYPAL_INVOICE_RECORDS` | `0` | `1` records each tab charge as a paid PayPal invoice |
| `LLM_PROVIDER` | `mock` (also in `.env.example`) | `ollama`, `openai` or `mock` |
| `LLM_BASE_URL` | `http://localhost:11434` (`https://api.openai.com` for `openai`) | Model server |
| `LLM_MODEL` | `gemma4:12b` | Model tag |
| `LLM_API_KEY` | | For OpenAI-compatible servers |
| `LLM_REVIEW_BUDGET_MS` | `45000` | Time for one spend review before it escalates, and for one dispute hearing (5,000 to 600,000) |
| `CHANNEL3_API_KEY` | | Seeds the real Channel3 API instead of the demo catalog |
| `SELLER_PAYPAL_EMAIL_CHANNEL3`, `_PRICEWATCH`, `_REVIEWS` | Placeholder addresses | Payout receivers for the demo sellers |
| `MASTER_KEY` | Generated into `DATA_DIR/master.key` | 32 bytes, hex or base64, for the seller key vault |
| `DATA_DIR` | `data` | SQLite file and master key, relative to the repo root |
| `PORT`, `SELLERS_PORT`, `HOST` | `4020`, `4030`, `localhost` | Listening |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | The gateway's origin: paywall URLs and PayPal return URLs |
| `WEB_BASE_URL` | `http://localhost:5173` | The web app's origin: CORS, allowed browser origin, the return page's fallback link |
| `SELLERS_BASE_URL` | `http://localhost:<SELLERS_PORT>` | Where the demo sellers are seeded |
| `DEMO_MODE` | on | Seeds demo data, enables the demo clock and rescheduling, allows localhost sellers, needs no admin token |
| `ADMIN_TOKEN` | | Required `x-p402-admin` value for writes when `DEMO_MODE=0` |
| `FLAKY_RATE` | `0.3` | Share of flaky ReviewPulse answers |
| `LOG_LEVEL`, `NODE_ENV` | `info`, `development` | `NODE_ENV=production` serves `packages/web/dist` |
| `VITE_AG_GRID_LICENSE_KEY`, `VITE_AG_STUDIO_LICENSE_KEY`, `VITE_BRYNTUM_LICENSE_KEY` | | Optional UI licenses |

**The context.** `src/context.ts` defines `AppContext` (`config`, `db`, `bus`, `clock`, `log`, `paypal`, `settlement`, `ai`, `runAgent`, `demoSellers`) and the service contracts. `createContext(config, overrides)` fills in anything not provided with stubs that throw `503 not_wired`, so a half-wired gateway fails loudly. `createTestContext()` gives tests an in-memory database, mock modes and silent logs.

**The composition root.** `src/services.ts` picks the real implementations: `createPaypalClient` (mock or sandbox by `PAYPAL_MODE`), `createAiService` (Ollama, OpenAI-compatible or mock, with the review budget, the demo clock, and a 700 ms pause between mock review and jury messages so the offline debates visibly stream), `createSettlementService`, `runAgent` and `demoSellers`.

**The clock.** `src/clock.ts` gives the gateway's time: real time plus an offset stored in `kv`, which only demo mode can change (`POST /api/clock/advance`, up to 60 days per step). Everything stored or scheduled uses it. Voucher freshness and the sandbox reauthorization check use real time instead.

**Startup** (`src/index.ts`): load the config, build the context, clean up work interrupted by the last shutdown (void pending vouchers, escalate running reviews, fail running agent runs and dispute hearings), build the server, seed demo data, start the scheduler, listen, then warm the model. `SIGINT` and `SIGTERM` stop the scheduler, close the server (aborting reviews, agent runs and dispute hearings) and the database, with a 10-second limit.

**The server** (`src/server.ts`) registers helmet, CORS, the `/api` rate limit, the admin guard, the WebSocket plugin and the route plugins: system, sellers, tabs, ledger, agents, AI, settlement, disputes, paywall, events. In production it also serves the built web app with an SPA fallback. All errors leave as `{ "error", "message", "details"? }`: zod errors become `400 invalid_request`, unexpected ones `500 internal_error` with nothing internal in the body.

## Security design

| Risk | Control | Where |
|---|---|---|
| Forged or altered payments | Ed25519 signature over the canonical voucher, checked against the key registered for that agent on that tab | `paywall/verify.ts` |
| Replay and double spend | Strict per-channel `seq` and `cumulative`, reserved in one transaction before forwarding; `UNIQUE (tab_id, seller_id, seq)` | `paywall/ledger.ts` |
| A voucher used for another request | The request hash binds method, path, query and body; the gateway forwards exactly the bytes it hashed | `voucher.ts`, `paywall/route.ts` |
| Stale vouchers | At most 5 minutes of life, 30 s of skew, judged on wall-clock time | `paywall/verify.ts` |
| Overspending by parallel calls | In-flight vouchers count toward the hold, daily cap and rate limit | `paywall/ledger.ts` |
| Rogue agent enrollment | Enroll tokens (32 random bytes) stored as SHA-256, compared in constant time; enrollment only on tabs that are pending approval, active or paused | `routes/tabs.ts` |
| Leaked seller keys | AES-256-GCM at rest with the seller id as associated data, 12-byte IVs and full 16-byte tags only; master key from `MASTER_KEY` or a generated file with 0600 permissions; a fingerprint detects a changed key; keys never returned | `sellers/vault.ts` |
| SSRF through seller URLs | https only (http for localhost in demo mode); no credentials, query or fragment; every resolved address must be public (private, loopback, link-local, CGNAT, multicast, documentation and IPv6 equivalents, including IPv4 embedded in mapped, translated, NAT64 and 6to4 addresses), checked at registration and again on every connection | `sellers/ssrf.ts`, `paywall/proxy.ts` |
| Abuse through the proxy | Allow-listed request headers only (`accept`, `accept-language`, `content-type`, `user-agent`); the client's auth, cookies and x402 headers are dropped; sellers can't claim reserved header names; 2 MB response cap, also after decompression; 1 MB request body cap | `paywall/proxy.ts`, `sellers/registry.ts` |
| Cross-site writes and DNS rebinding | CORS limited to `WEB_BASE_URL`; with `DEMO_MODE=0` every write under `/api` needs the admin header, compared in constant time; in demo mode browser writes are accepted only from the app's, the gateway's or a localhost origin; `/ws` checks the origin | `http/guards.ts`, `ws.ts` |
| Request floods | 3,000 requests a minute per client on `/api`; per-tab policy limits on the paywall | `server.ts` |
| Injected content in HTML pages | Helmet; a strict CSP for the built app; a nonce-based CSP, `no-store` and `no-referrer` on the PayPal return and mock pages, which also escape everything they show | `http/guards.ts`, `settlement/pages.ts` |
| Prompt injection in the AI review | Untrusted excerpts fenced in `<evidence>`, flattened and stripped of angle brackets; facts computed from the ledger; the ruling validated against the evidence; voids limited to the tab's accepted, unsettled calls; low confidence escalates | `packages/ai/src/review/`, `review/runner.ts` |
| Prompt injection in the dispute jury | The buyer's message fenced in `<evidence>`, flattened, angle brackets replaced, 600 characters at most; facts and signature counts computed from the ledger; the refund forced to agree with the recommendation; the jury only recommends and a human sends every response | `packages/ai/src/dispute/`, `disputes/` |
| Paying out money a dispute may take back | While a dispute is open, the sellers' share of it is held from payouts; a refund is deducted once, pro rata by gross, in the transaction that advances `refund_applied_cents`. Money already paid out can't be held: a later refund takes the balance below zero instead | `disputes/store.ts`, `settlement/payouts.ts` |
| Demo shortcuts on real disputes | Ruling on a dispute needs `DEMO_MODE=1`; simulating one exists only with mock PayPal; both are `/api` writes behind the admin guard | `disputes/index.ts`, `routes/disputes.ts` |
| Vouchers leaking to third parties | The reference client refuses to sign for or send to any origin but its gateway's, and never sends `/api` headers to the paywall | `packages/agent/src/x402Client.ts` |
| Secrets in logs | pino redacts authorization, cookies, `x-api-key`, the admin header, `payment-signature` and secret-named fields; the PayPal secret lives only in the token cache's closure; PayPal errors keep `debug_id` but never the outgoing request | `context.ts`, `paypal/oauth.ts`, `paypal/errors.ts` |
| Bad input | zod on every route and on the AI's own answers; parameterized SQL only | everywhere |

**Fixed in the security review**, each with a test:

1. The admin guard could be bypassed with a percent-encoded path such as `/%61pi/...`, which the router still matched. The guard now checks the matched route pattern.
2. In demo mode, other sites' pages could send writes from a visitor's browser. Writes from foreign browser origins now get `403 forbidden_origin`.
3. A call still in flight when its tab closed could be accepted after the charge was computed, and never billed. Closing now waits for in-flight calls and voids what is left before computing the charge.
4. Node accepts GCM tags truncated to 4 bytes, which are forgeable. The vault now accepts only full 16-byte tags.
5. The SSRF guard missed the IPv4-translated IPv6 range (`::ffff:0:0:0/96`). It is now blocked.
6. The alarm message, which quotes the agent's own request, was part of the review's trusted facts. It now sits in the fenced evidence and the facts carry only the alarm's kind.
7. The agent's client would sign a voucher for any URL it was given. It now refuses origins other than its gateway's.

`npm audit` reported no vulnerabilities after the review.

**Still open:**

- `GET /paypal/cancel` is unauthenticated and its `ref` and `token` can be read from `GET /api/tabs`, so anyone who can reach the gateway can cancel a hold approval in progress. A random nonce in the return and cancel URLs would close it.
- Opening a new hold cancels the company's unapproved tabs; if one of them is being authorized at that moment, its PayPal authorization can be left open. It should be voided when the status update changes no rows.
- Seller response schemas may contain slow regular expressions; rejecting `pattern` would close that.
- Demo mode refuses writes from browser origins other than the app or localhost, so LAN access needs `WEB_BASE_URL` set to that origin. Demo mode itself has no admin token and belongs on localhost.
- Per-tab locks, the dispute sync's lock and running juries are in memory, so the design assumes one gateway process per database.

## Testing

`npm test` runs 387 Vitest tests in 36 files in a few seconds, entirely offline. `npm run typecheck` runs `tsc` in every package.

| Package | Tests | How |
|---|---:|---|
| gateway | 228 | `test/helpers.ts` builds an offline gateway (in-memory SQLite, demo mode) with Fastify's `inject`, a fake seller on a local port with scripted behaviors (ok, 500, 404, 402, empty bodies, empty arrays and objects, empty result lists, broken JSON, plain text, slow, oversized, gzip, connection reset, echo) and a test agent that signs vouchers like the real client. Core tests fake the settlement and AI services; settlement and dispute tests use the real services on the mock PayPal with a controllable clock (disputes with the mock jury); the sandbox client runs through the real Server SDK, with an axios adapter standing in for PayPal's Orders and Payments endpoints and a fake `fetch` for OAuth, Payouts, Disputes v1 and Invoicing v2 shaped like PayPal's REST reference. |
| ai | 101 | A scriptable fake Ollama and OpenAI-compatible server on 127.0.0.1; policy parsing and fallbacks, structured-output retries, review decisions and prompt fencing, the dispute jury (its ledger rules, fencing the buyer's message, a scripted model, the fallback and the budget), grid plans, the chat proxy. |
| agent | 25 | A fake paywall: paying on the first request, quotes, resync, repricing, pauses and their limits, frozen tabs, foreign-origin refusal, and all three agent modes, including the planner fallback. |
| sellers | 13 | The demo sellers over HTTP, including seeded flakiness. |
| shared | 12 | Money math, fees, pro-rata allocation, signing and verification, the request hash, header encoding. |
| web | 8 | Formatting helpers and the jury docket's rules: ordering, open cases, filters, streamed messages, labels. |

Highlights: the full verification matrix with every 402 reason; two concurrent vouchers with the same sequence number (exactly one gets through); hold, rate and daily limits counting calls in flight; every quality-guard rule through the real proxy; the alarm detectors and every review outcome, including human decisions and timeouts; the scheduler's day-4, day-7, small-tab, expiry and sandbox paths; settlement idempotency, carry, the $0 close, crash recovery and the ledger invariant; payouts, including partial failures; disputes on a tab charge (sellers' earnings held, the jury contesting an unauthorised claim, a partial refund deducted pro rata by gross exactly once, a frozen runaway's repeats refunded, a dispute the seller ignored closing for the buyer on the demo clock, disputes on other captures left unlinked, the demo-only routes); dispute evidence sent as multipart with an `input` JSON part; invoice records made once, off by default and retried after a failure; a v1 database upgraded in place and a newer one refused; SSRF and vault cases; the admin guard, CORS and origin checks; and an end-to-end run over real HTTP and a WebSocket, with a scripted agent and a runaway agent that ends frozen.

Two scripts cover the real services: `npm run check:paypal` walks the sandbox money path with a human approving the hold, and also lists disputes and, with `PAYPAL_INVOICE_RECORDS=1`, records an invoice; `npm run check:llm` checks the configured model on every AI feature except the dispute jury, with timings.
