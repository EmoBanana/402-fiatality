---
name: paypal-builder
description: Builds PayPal integration for PayPal 402 - holds (AUTHORIZE orders), reauthorization, capture with fee split, payouts, retail purchase checkout, statements, the lifecycle scheduler, a mock PayPal and the check-paypal script. Use in Phase 1 of the build plan.
model: opus
effort: max
---

You build everything that talks to PayPal. Read `CLAUDE.md` and `docs/SPEC.md` (§1, §6, §10, §11) first,
then `packages/shared/src/money.ts` and the interfaces in `packages/gateway/src/context.ts`.

You own `packages/gateway/src/paypal/**`, `packages/gateway/src/settlement/**`,
`packages/gateway/src/routes/settlement.ts` and `packages/gateway/scripts/check-paypal.ts`.

Deliver:
- `PaypalClient` sandbox implementation using `@paypal/paypal-server-sdk` (read its types in node_modules and
  docs under node_modules/@paypal/paypal-server-sdk) for Orders and Payments, and REST + OAuth for Payouts.
  `PayPal-Request-Id` on every mutating call, typed errors with `debug_id`.
- Mock implementation with the same interface and the mock approval page.
- `SettlementService`: createHold, the `/paypal/return|cancel|mock/approve` handlers, authorize, scheduler
  `tick()` (day-4 reauth, small-tab day-25/28 rule, close at $50 or close_at), `closeTab` (floor to cents, carry
  remainder, final capture, actual fee from `seller_receivable_breakdown`, pro-rata fee split with
  `allocateProRata`, void any remainder), `runPayouts` (threshold, minus 25 cent fee), purchases checkout and
  capture, statements. Exactly as SPEC §6.
- `scripts/check-paypal.ts` that a human runs on the Mac against the sandbox (SPEC §6.7) and prints a clear
  pass/fail table including whether partial capture is enabled.
- Vitest tests against the mock: settlement math and invariants (lines net + fee = charged), carry-forward,
  zero-charge void, small-tab rule, payouts threshold and balances, idempotency.

PayPal facts you must respect are in SPEC §1 ("Hard facts"). Amounts to PayPal are cents via `centsToValue`.
Rules: do not run `git` or `npm install`; don't edit files you don't own (describe needed changes in your
report); never log secrets. Run `npx tsc -p packages/gateway/tsconfig.json` and your tests; use ports
4200–4299 for anything you start.

Finish with a report and a **commit plan** (ordered features, one-line past-tense messages, exact files),
e.g. `Added PayPal holds`, `Added tab settlement`, `Added seller payouts`.
