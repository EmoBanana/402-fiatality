/**
 * Landing (SPEC §9.2): the hero is an HTTP response (`HTTP/1.1 402 Fiatality`, a real PAYMENT-REQUIRED header, then
 * the tagline as the body) beside the IOU tape; then how it works, the math, for sellers, built with.
 * Every figure is computed with the same @p402/shared fee functions the ledger uses. Responsive to 375 px.
 */
import { captureFeeCents, effectiveRatePct, naiveFeeCents, PAYPAL_US_FEES } from "@p402/shared";
import { Link } from "react-router";
import { buttonClassName } from "../components/Button";
import { Money } from "../components/Money";
import { IouTape } from "../features/landing/IouTape";
import { LiveProof } from "../features/landing/LiveProof";
import "../features/landing/landing.css";
import { formatCount, formatPct } from "../lib/format";

/** The start of a real x402 v2 PAYMENT-REQUIRED header (base64 JSON) for a $0.005 search. */
const PAYMENT_REQUIRED_SAMPLE = "eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJwYXltZW50X3JlcXVpcmVkIiwicmVz…";

const STEPS = [
  {
    when: "Day 0",
    title: "Hold",
    body: "Finance approves one PayPal hold for the whole company, $50 by default. Nothing is charged yet.",
  },
  {
    when: "Every call",
    title: "IOU per call",
    body: "Each agent signs an IOU for the exact price, even $0.005. The gateway checks the signature and sequence locally, so paying adds no PayPal round trip.",
  },
  {
    when: "As it happens",
    title: "AI guard",
    body: "Errors, timeouts and empty results are voided under rules each seller publishes. If spending looks wrong, Gemma 4 reviews it and can freeze the agent.",
  },
  {
    when: "At $50 or day 7",
    title: "One charge",
    body: "The tab closes with a single PayPal capture and the rest of the hold is released. Sellers are paid weekly.",
  },
] as const;

/** 1,000 calls worth $50: per-call PayPal payments vs one tab. */
const CALLS = 1_000;
const TAB_CENTS = 5_000;
const naiveCents = naiveFeeCents(CALLS, TAB_CENTS * 10_000);
const batchedCents = captureFeeCents(TAB_CENTS);
const payoutFeeCents = PAYPAL_US_FEES.payoutApiFlatCents;
const sellerNetCents = TAB_CENTS - batchedCents - payoutFeeCents;
const sellerKeepPct = (sellerNetCents / TAB_CENTS) * 100;
const checkout = PAYPAL_US_FEES.checkout;

const BUILT_WITH = [
  { name: "PayPal", role: "Holds, the one capture and seller payouts (Orders v2, Payouts)" },
  { name: "Gemma 4", role: "Reads budgets in plain English and runs spend reviews, locally through Ollama" },
  { name: "AG Grid", role: "The clearing terminal: every IOU, live" },
  { name: "Bryntum", role: "The tab timeline: hold, renewal, charge and payouts" },
  { name: "Channel3", role: "Product data the shopping agent pays for" },
] as const;

function NotApplicable() {
  return (
    <>
      <span aria-hidden="true">—</span>
      <span className="visually-hidden">not applicable</span>
    </>
  );
}

export default function Landing() {
  return (
    <div className="lp">
      <section className="lp-hero" aria-labelledby="lp-title">
        <div className="lp-wrap lp-hero-grid">
          <div className="lp-hero-copy">
            <div className="lp-response">
              <p className="lp-status">
                <span className="lp-status-proto">HTTP/1.1</span> <span className="lp-status-code">402</span>{" "}
                <span className="lp-status-reason">
                  <b>Fiat</b>ality
                </span>
              </p>
              <p className="lp-header-line" aria-hidden="true">
                <span>PAYMENT-REQUIRED:</span> {PAYMENT_REQUIRED_SAMPLE}
              </p>
            </div>
            <h1 id="lp-title" className="lp-title">
              <span>Agents pay per call.</span> <span>Finance pays once.</span>
            </h1>
            <p className="lp-lede">
              Your agents sign an IOU for every paid API call, bad responses are voided before anyone pays, and the whole tab settles as one
              PayPal charge.
            </p>
            <div className="lp-ctas">
              <Link to="/console" className={buttonClassName({ variant: "primary", size: "lg" })}>
                Open console
              </Link>
              <Link to="/terminal" className={buttonClassName({ variant: "secondary", size: "lg" })}>
                View terminal
              </Link>
            </div>
            <LiveProof />
          </div>
          <IouTape />
        </div>
      </section>

      <section className="lp-section" aria-labelledby="lp-how">
        <div className="lp-wrap">
          <header className="lp-section-head">
            <p className="ui-eyebrow">How it works</p>
            <h2 id="lp-how">One hold, thousands of IOUs, one charge.</h2>
          </header>
          <ol className="lp-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="lp-step">
                <p className="lp-step-when">{step.when}</p>
                <h3>
                  <span className="lp-step-n">{i + 1}</span>
                  {step.title}
                </h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="lp-section" aria-labelledby="lp-math">
        <div className="lp-wrap lp-math">
          <header className="lp-section-head">
            <p className="ui-eyebrow">The math</p>
            <h2 id="lp-math">A $0.005 call can't be charged on PayPal. A tab can.</h2>
            <p className="lp-section-lede">
              PayPal amounts stop at two decimals, and every payment carries a fixed fee. Batching sub-cent IOUs into one tab is the only way
              the numbers work.
            </p>
          </header>
          <div className="lp-table-wrap">
            <table className="lp-math-table">
              <caption className="visually-hidden">PayPal fees for per-call payments versus one batched tab</caption>
              <thead>
                <tr>
                  <th scope="col">Scenario</th>
                  <th scope="col">What PayPal sees</th>
                  <th scope="col" className="is-num">
                    PayPal fees
                  </th>
                  <th scope="col" className="is-num">
                    Fee rate
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">
                    One API call at <Money micros={5_000} />
                  </th>
                  <td>Nothing: an amount below one cent is rejected</td>
                  <td className="is-num muted" data-label="PayPal fees">
                    <NotApplicable />
                  </td>
                  <td className="is-num muted" data-label="Fee rate">
                    <NotApplicable />
                  </td>
                </tr>
                <tr>
                  <th scope="row">
                    {formatCount(CALLS)} calls worth <Money cents={TAB_CENTS} />, paid one by one
                  </th>
                  <td>{formatCount(CALLS)} separate payments</td>
                  <td className="is-num" data-label="PayPal fees">
                    <Money cents={naiveCents} />
                  </td>
                  <td className="is-num" data-label="Fee rate">
                    {formatPct(effectiveRatePct(naiveCents, TAB_CENTS), 1)}
                  </td>
                </tr>
                <tr className="lp-math-win">
                  <th scope="row">The same calls on one 402 Fiatality tab</th>
                  <td>
                    1 payment of <Money cents={TAB_CENTS} />
                  </td>
                  <td className="is-num" data-label="PayPal fees">
                    <Money cents={batchedCents} />
                  </td>
                  <td className="is-num" data-label="Fee rate">
                    {formatPct(effectiveRatePct(batchedCents, TAB_CENTS))}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="lp-footnote">
            US PayPal Checkout pricing, {formatPct(checkout.basisPoints / 100)} + <Money cents={checkout.fixedCents} /> per payment, computed with the
            same fee functions the ledger uses. PayPal earns on agent spending it sees none of today.
          </p>
        </div>
      </section>

      <section className="lp-section" aria-labelledby="lp-sellers">
        <div className="lp-wrap lp-sellers">
          <div className="lp-sellers-copy">
            <p className="ui-eyebrow">For sellers</p>
            <h2 id="lp-sellers">List an API. Keep about {Math.round(sellerKeepPct)}%.</h2>
            <p className="lp-section-lede">
              Put a price on each endpoint, even a fraction of a cent, and publish what isn't billable: errors, timeouts, empty results. Agents
              pay through the gateway and you're paid weekly through PayPal payouts once you're owed $10.
            </p>
            <Link to="/sellers?new=1" className={buttonClassName({ variant: "secondary" })}>
              List your API
            </Link>
          </div>
          <div className="lp-slip" aria-labelledby="lp-slip-title">
            <p id="lp-slip-title" className="lp-slip-title">
              If one <Money cents={TAB_CENTS} /> tab were all yours
            </p>
            <ol className="ui-ledger">
              <li className="ui-ledger-row">
                <span className="ui-ledger-label">Gross from the tab</span>
                <Money cents={TAB_CENTS} className="ui-ledger-amount" />
              </li>
              <li className="ui-ledger-row">
                <span className="ui-ledger-label">Share of the PayPal fee</span>
                <Money cents={-batchedCents} className="ui-ledger-amount" />
              </li>
              <li className="ui-ledger-row">
                <span className="ui-ledger-label">Weekly payout fee</span>
                <Money cents={-payoutFeeCents} className="ui-ledger-amount" />
              </li>
              <li className="ui-ledger-total ui-ledger-grand">
                <span className="ui-ledger-label">You receive · {formatPct(sellerKeepPct, 1)}</span>
                <Money cents={sellerNetCents} className="ui-ledger-amount" />
              </li>
            </ol>
          </div>
        </div>
      </section>

      <section className="lp-section" aria-labelledby="lp-built">
        <div className="lp-wrap lp-built">
          <p id="lp-built" className="ui-eyebrow">
            Built with
          </p>
          <dl className="lp-built-list">
            {BUILT_WITH.map((item) => (
              <div key={item.name}>
                <dt>{item.name}</dt>
                <dd>{item.role}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      <footer className="lp-footer">
        <div className="lp-wrap lp-footer-inner">
          <p>402 Fiatality · Built for the PayPal AI Hackathon 2026</p>
          <nav aria-label="Footer" className="lp-footer-nav">
            <Link to="/console">Console</Link>
            <Link to="/terminal">Terminal</Link>
            <Link to="/jury">Jury</Link>
            <Link to="/sellers">Sellers</Link>
            <Link to="/insights">Insights</Link>
            <Link to="/timeline">Timeline</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
