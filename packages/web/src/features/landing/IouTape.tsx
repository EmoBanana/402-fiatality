/**
 * The landing hero's IOU tape: a receipt of signed sub-cent IOUs (voids struck through in red) that ends in
 * the floor-to-cents line - one PayPal charge, with the sub-cent remainder carried to the next tab.
 * Lines print in once on load (CSS only; reduced motion shows the final state).
 */
import { captureFeeCents, effectiveRatePct, formatUsd, type Micros, microsToCentsFloor } from "@p402/shared";
import type { CSSProperties } from "react";
import { Money } from "../../components/Money";
import { formatCount } from "../../lib/format";

interface TapeLine {
  seller: string;
  call: string;
  price: Micros;
  void?: string;
}

const LINES: TapeLine[] = [
  { seller: "channel3", call: "POST /v1/search", price: 5_000 },
  { seller: "channel3", call: "GET /v1/products/:id", price: 2_000 },
  { seller: "channel3", call: "GET /v1/products/:id", price: 2_000 },
  { seller: "pricewatch", call: "GET /v1/history/:id", price: 10_000 },
  { seller: "reviews", call: "GET /v1/reviews/:id", price: 3_000, void: "empty result" },
  { seller: "reviews", call: "GET /v1/reviews/:id", price: 3_000 },
  { seller: "channel3", call: "POST /v1/search", price: 5_000 },
  { seller: "reviews", call: "GET /v1/reviews/:id", price: 3_000, void: "seller error 503" },
  { seller: "pricewatch", call: "GET /v1/history/:id", price: 10_000 },
];

/** The tab this tape closes: ~10k IOUs that reached the $50 close-at line. */
const TOTAL_IOUS = 10_241;
const TOTAL_VOIDS = 312;
const BILLABLE: Micros = 50_003_500;

export function IouTape() {
  let running = 0;
  const rows = LINES.map((line) => {
    if (!line.void) running += line.price;
    return { ...line, cumulative: running };
  });
  const { cents: chargeCents, remainderMicros } = microsToCentsFloor(BILLABLE);
  const feeCents = captureFeeCents(chargeCents);
  const rate = effectiveRatePct(feeCents, chargeCents);
  const hiddenCount = TOTAL_IOUS - LINES.length;
  const delay = (i: number): CSSProperties => ({ ["--i" as string]: i });

  return (
    <figure className="lp-tape" aria-labelledby="lp-tape-caption">
      <figcaption id="lp-tape-caption" className="visually-hidden">
        A tab's IOU tape: {formatCount(TOTAL_IOUS)} sub-cent IOUs, {TOTAL_VOIDS} voided, billable {formatUsd(BILLABLE)}, settled as one PayPal
        charge of {formatUsd(chargeCents * 10_000)} with {formatUsd(remainderMicros)} carried to the next tab.
      </figcaption>
      <div className="lp-tape-head" aria-hidden="true">
        <span>Tab · Northwind Research</span>
        <span>
          Hold <Money cents={5_000} />
        </span>
      </div>
      <div className="lp-tape-cols" aria-hidden="true">
        <span>IOU</span>
        <span>Price</span>
        <span className="lp-tape-cum">Tab total</span>
      </div>
      <ol className="lp-tape-lines" aria-hidden="true">
        {rows.map((row, i) => (
          <li key={i} className="lp-tape-line" data-void={row.void ? true : undefined} style={delay(i)}>
            <span className="lp-tape-call">
              <span className="lp-tape-seller">{row.seller}</span> {row.call}
              {row.void ? <span className="lp-tape-void">void · {row.void}</span> : null}
            </span>
            <Money micros={row.price} padTo={3} className="lp-tape-price" />
            <Money micros={row.cumulative} padTo={3} className="lp-tape-cum" />
          </li>
        ))}
        <li className="lp-tape-more" style={delay(rows.length)}>
          <span>+ {formatCount(hiddenCount)} more IOUs this week</span>
        </li>
      </ol>
      <dl className="lp-tape-totals" aria-hidden="true" style={delay(rows.length + 2)}>
        <div className="lp-tape-sum">
          <dt>
            Billable <span className="lp-tape-meta">· {formatCount(TOTAL_IOUS)} IOUs, {TOTAL_VOIDS} voided</span>
          </dt>
          <dd>
            <Money micros={BILLABLE} padTo={4} />
          </dd>
        </div>
        <div className="lp-tape-grand">
          <dt>One PayPal charge</dt>
          <dd>
            <Money cents={chargeCents} padTo={4} />
          </dd>
        </div>
        <div className="lp-tape-aside">
          <dt>Carried to next tab</dt>
          <dd>
            <Money micros={remainderMicros} padTo={4} />
          </dd>
        </div>
        <div className="lp-tape-aside">
          <dt>PayPal fee · {rate.toFixed(2)}%</dt>
          <dd>
            <Money cents={feeCents} padTo={4} />
          </dd>
        </div>
      </dl>
    </figure>
  );
}
