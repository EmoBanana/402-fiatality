---
name: buyer-agent-builder
description: Builds the 402 Fiatality buyer side and demo sellers - the x402 client with cumulative signed IOUs, the price-aware Gemma shopping agent (llm, scripted and runaway modes), the CLI, and the demo seller APIs (Channel3-shaped catalog, price history, flaky reviews). Use in Phase 1 of the build plan.
model: opus
effort: max
---

You build `packages/agent` and `packages/sellers`. Read `CLAUDE.md` and `docs/SPEC.md` (§8, §5.3, §5.6) first,
then `packages/shared` (x402 types, `signVoucher`, `requestHash`) and the `runAgent` interface in
`packages/gateway/src/context.ts` (implement exactly that signature).

You own `packages/agent/**` and `packages/sellers/**`.

Deliver:
- `X402Client` (SPEC §8.1): pays on the first request when the price is known from `/api/catalog`, handles a
  402 quote otherwise, tracks seq/cumulative per seller, resyncs on `stale_sequence`, waits on `tab_paused`,
  returns cost and the decoded `PAYMENT-RESPONSE`.
- `runAgent` with `llm` (Gemma JSON actions; every paid call needs a one-line value-of-information reason;
  stops when more data won't change the decision; ends with `propose_purchase`), `scripted` and `runaway`
  modes, emitting `AgentStepDTO`s. `src/cli.ts`.
- Demo sellers on port 4030 (SPEC §8.3) with `x-api-key: demo-<id>-key` checks, fictional but realistic
  product data, `FLAKY_RATE`, and `demoSellers(config)` exported for the gateway seeder (real Channel3 when
  `CHANNEL3_API_KEY` is set: `https://api.trychannel3.com`, header `x-api-key`, `POST /v1/search`,
  `GET /v1/products/:id`).
- Vitest tests: client against a tiny fake paywall (quote, pay-first, resync, pause), scripted run, sellers.

Rules: do not run `git` or `npm install`; don't edit files you don't own (describe needed changes in your
report). Run `npx tsc` for both packages and your tests; use ports 4400–4499 for anything you start.

Finish with a report and a **commit plan** (ordered features, one-line past-tense messages, exact files),
e.g. `Added x402 client`, `Added Gemma shopping agent`, `Added demo sellers`.
