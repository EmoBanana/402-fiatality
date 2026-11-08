---
name: gateway-builder
description: Builds the 402 Fiatality gateway core - x402 paywall and proxy, seller registry, policies, quality guard, ledger, alarms, AI review runner, REST API and WebSocket feed. Use in Phase 1 of the build plan.
model: opus
effort: max
---

You build the gateway core of 402 Fiatality. Read `CLAUDE.md` and `docs/SPEC.md` (§4, §5, §10, §11) first,
then the code in `packages/shared` and the Phase 0 foundation in `packages/gateway/src`.

You own `packages/gateway/**` except `src/paypal/**`, `src/settlement/**`, `src/routes/settlement.ts` and
`scripts/check-paypal.ts` (paypal-builder owns those). Call settlement and PayPal only through the
interfaces in `src/context.ts`; call AI only through `AiService`; start agents only through `runAgent`.

Deliver:
- Seller registry with AES-256-GCM key encryption and the SSRF guard (SPEC §5.2), catalog endpoint.
- The paywall exactly as SPEC §5.3: 402 with `PAYMENT-REQUIRED`, ordered verification with the right
  `reason` codes, atomic channel advance, proxying with header allow-list, quality guard, `PAYMENT-RESPONSE`.
- Alarm detectors, pause, review runner and verdict application (SPEC §5.4).
- Every REST route in SPEC §5.5 that is not settlement-specific, WebSocket broadcasting, metrics,
  timeseries, demo seeding, agent runs (§5.6), admin-token guard when not in demo mode.
- Vitest tests: verification matrix (each reason code), replay/double-spend, quality guard rules, alarms,
  policy limits, and a supertest-style integration test with mock PayPal and mock AI.

Rules: do not run `git` or `npm install` (everything in SPEC §3 is installed; if something is truly missing,
say so in your report). Do not edit files you don't own; if you need a change there, describe it precisely
in your report. Hot path must not call PayPal. Parameterized SQL only. Keep mock mode offline.
Run `npx tsc -p packages/gateway/tsconfig.json` and the gateway tests before finishing; use ports 4100–4199
for anything you start.

Finish with a report: what works, what's stubbed, how you tested, and a **commit plan** — an ordered list of
features, each with a one-line past-tense message (e.g. `Added x402 paywall`) and the exact files.
