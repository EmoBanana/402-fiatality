/**
 * Demo `reviews` seller: GET /v1/reviews/:productId -> rating summary and review snippets, deterministic per
 * product. Flaky on purpose so the gateway's void rules have something to catch: FLAKY_RATE is the total
 * flaky share, split 1/2 HTTP 500, 1/3 empty result, 1/6 malformed JSON (0.3 -> 15 / 10 / 5 %).
 */
import type { FastifyInstance } from "fastify";
import { type CategoryKey, findProduct } from "./catalog";
import { mulberry32, pick, rngFor, sample } from "./rng";

export type FlakyOutcome = "ok" | "error" | "empty" | "malformed";

/** Draws one outcome per request. With a seed the sequence is reproducible (tests). */
export function createFlaky(rate: number, seed?: number): () => FlakyOutcome {
  const r = Number.isFinite(rate) ? Math.min(1, Math.max(0, rate)) : 0;
  const rng = seed === undefined ? Math.random : mulberry32(seed);
  return () => {
    const x = rng();
    if (x < r / 2) return "error";
    if (x < (r * 5) / 6) return "empty";
    if (x < r) return "malformed";
    return "ok";
  };
}

type Stars = "1" | "2" | "3" | "4" | "5";

export interface ReviewSnippet {
  id: string;
  rating: number;
  title: string;
  body: string;
  author: string;
  date: string;
  verified_purchase: boolean;
}

export interface ReviewsSummary {
  product_id: string;
  rating: number | null;
  count: number;
  distribution: Record<Stars, number>;
  highlights: { pros: string[]; cons: string[] };
  reviews: ReviewSnippet[];
}

interface Pool {
  pros: string[];
  cons: string[];
  positive: Array<[string, string]>;
  mixed: Array<[string, string]>;
  negative: Array<[string, string]>;
}

const POOLS: Record<CategoryKey | "generic", Pool> = {
  espresso: {
    pros: ["Rich crema from the first shot", "Steam wand makes silky microfoam", "Heats up quickly", "Solid, well-built feel", "Easy to clean", "Consistent shot temperature"],
    cons: ["Learning curve for beginners", "Drip tray fills quickly", "Loud when steaming", "Takes a lot of counter space", "Portafilter handle gets hot"],
    positive: [
      ["Cafe-quality at home", "Dialing in took a weekend; now every shot is consistent and I've stopped buying coffee out."],
      ["Worth every penny", "Steams milk faster than my old machine and the shots taste noticeably sweeter."],
      ["Great first machine", "Simple controls, quick heat-up, and the frother is easy to master."],
      ["Daily driver", "Two lattes a day for three months and it still performs like new."],
    ],
    mixed: [
      ["Good, not perfect", "Shots are good, but the drip tray is tiny and needs emptying every day."],
      ["Solid but noisy", "Coffee quality is great; the pump is louder than I hoped in the mornings."],
    ],
    negative: [
      ["Disappointed", "Temperature drifted after a few weeks and support was slow to respond."],
      ["Returned it", "It leaked from the group head within a month."],
    ],
  },
  headphones: {
    pros: ["Noise cancelling is excellent on flights", "Comfortable for hours", "Battery lasts all week", "Clear call quality", "Balanced, detailed sound", "Pairs with two devices at once"],
    cons: ["Ear pads get warm", "Case is bulky", "Companion app is clunky", "Touch controls are too sensitive", "Bass is light out of the box"],
    positive: [
      ["Silence on my commute", "The noise cancelling turns a loud train into a quiet office, and the battery lasts the week."],
      ["Best pair I've owned", "Detailed, balanced sound, and I forget I'm wearing them."],
      ["Great for calls", "Coworkers say I sound clearer than on my laptop microphone."],
      ["Comfort champion", "Wore them through a nine-hour flight without any pressure points."],
    ],
    mixed: [
      ["Good sound, so-so fit", "Sound is great, but they clamp a bit on larger heads."],
      ["Almost perfect", "Love the noise cancelling; the touch controls trigger by accident."],
    ],
    negative: [
      ["Connection drops", "Bluetooth drops every few minutes on my laptop."],
      ["Cracked hinge", "The hinge cracked after two months of normal use."],
    ],
  },
  desks: {
    pros: ["Rock-solid at standing height", "Quiet, smooth motors", "Memory presets are handy", "Straightforward assembly", "Plenty of desk space", "Sturdy frame"],
    cons: ["Heavy boxes, assembly needs two people", "Slight wobble at full height", "Cable management costs extra", "Control panel feels cheap", "Motor hum is noticeable"],
    positive: [
      ["Back pain gone", "Switching between sitting and standing every hour made a real difference, and there's no wobble."],
      ["Built like a tank", "Holds two monitors and a laptop dock without breaking a sweat."],
      ["Easy assembly", "Took about 45 minutes and the instructions were clear."],
      ["Quiet and fast", "The motors are quiet enough to adjust during video calls."],
    ],
    mixed: [
      ["Good desk, average top", "The frame is excellent; the top scratches more easily than expected."],
      ["Some wobble", "Stable when sitting, slight wobble when typing at full height."],
    ],
    negative: [
      ["Motor failed", "One motor stopped working after five weeks."],
      ["Arrived damaged", "A corner of the top was crushed and the replacement took weeks."],
    ],
  },
  shoes: {
    pros: ["Cushioned but still responsive", "True to size", "Breathable upper", "Durable outsole", "Great for long runs", "Light on the foot"],
    cons: ["Narrow toe box", "Laces come undone", "Firm for the first few runs", "Runs half a size small", "Outsole wears fast on asphalt"],
    positive: [
      ["Marathon-ready", "Trained a full marathon block in these with zero blisters."],
      ["Fresh legs", "Recovery runs feel easy and my legs feel fresher the next day."],
      ["Perfect daily trainer", "Comfortable from the first run and still bouncy after 300 miles."],
      ["Light and fast", "Great for tempo days; they feel lighter than the spec sheet says."],
    ],
    mixed: [
      ["Good but narrow", "The ride is great, but the toe box is tight for wide feet."],
      ["Takes some break-in", "Felt stiff the first week, then really comfortable."],
    ],
    negative: [
      ["Wore out quickly", "The outsole was smooth after 150 miles."],
      ["Blisters", "The heel counter rubbed badly no matter how I laced them."],
    ],
  },
  generic: {
    pros: ["Good value for the price", "Arrived quickly", "Works as described", "Solid build quality", "Easy to set up"],
    cons: ["Packaging could be better", "Instructions are thin", "Color differs slightly from the photos", "Customer support is slow"],
    positive: [
      ["Does the job", "Exactly as described and easy to set up."],
      ["Happy with it", "Good quality for the price; I would buy it again."],
      ["Recommended", "Works well after a month of daily use."],
    ],
    mixed: [
      ["Okay", "Decent overall, with a few rough edges."],
      ["Mixed feelings", "It works, but the build feels cheaper than expected."],
    ],
    negative: [["Not great", "Stopped working properly after a few weeks."]],
  },
};

const AUTHORS = ["Maya R.", "Daniel K.", "Priya S.", "Tom W.", "Aisha B.", "Lucas M.", "Hana T.", "Owen P.", "Sofia L.", "Ravi N.", "Grace H.", "Mateo C.", "Elena V.", "Sam O."];
const DAY_MS = 86_400_000;

/**
 * Star counts whose mean equals `rating` exactly: with d = 5 - rating, each lower star gets a fixed share of d
 * (weights chosen so that 4*p1 + 3*p2 + 2*p3 + p4 = d).
 */
function distribution(rating: number, count: number): Record<Stars, number> {
  const d = Math.min(1.75, Math.max(0, 5 - rating));
  const share = { "1": 0.08 * d, "2": 0.05 * d, "3": 0.1 * d, "4": 0.33 * d };
  const out: Record<Stars, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let assigned = 0;
  for (const star of ["1", "2", "3", "4"] as const) {
    out[star] = Math.round(share[star] * count);
    assigned += out[star];
  }
  out["5"] = Math.max(0, count - assigned);
  return out;
}

export function reviewsFor(productId: string, today: Date = new Date()): ReviewsSummary {
  const product = findProduct(productId);
  const rng = rngFor("reviews", productId);
  const rating = product?.rating ?? Math.round((3.6 + rng() * 1.1) * 10) / 10;
  const count = product?.reviewCount ?? 40 + Math.floor(rng() * 1_500);
  const pool = POOLS[product?.category ?? "generic"];
  const dist = distribution(rating, count);

  const starsFor = (): number => {
    let x = rng() * count;
    for (const star of ["5", "4", "3", "2", "1"] as const) {
      x -= dist[star];
      if (x < 0) return Number(star);
    }
    return 5;
  };
  const used = new Set<string>();
  const reviews: ReviewSnippet[] = [];
  for (let i = 0; i < 3; i++) {
    const stars = starsFor();
    const bucket = stars >= 4 ? pool.positive : stars === 3 ? pool.mixed : pool.negative;
    const choices = bucket.filter(([title]) => !used.has(title));
    const [title, body] = pick(rng, choices.length > 0 ? choices : bucket);
    used.add(title);
    reviews.push({
      id: `rv_${productId}_${i + 1}`,
      rating: stars,
      title,
      body,
      author: pick(rng, AUTHORS),
      date: new Date(today.getTime() - (1 + Math.floor(rng() * 90)) * DAY_MS).toISOString().slice(0, 10),
      verified_purchase: rng() < 0.85,
    });
  }
  reviews.sort((a, b) => (a.date < b.date ? 1 : -1));

  const strong = rating >= 4.3;
  return {
    product_id: productId,
    rating,
    count,
    distribution: dist,
    highlights: { pros: sample(rng, pool.pros, strong ? 3 : 2), cons: sample(rng, pool.cons, strong ? 1 : 3) },
    reviews,
  };
}

/** Any single path segment: real Channel3 ids are opaque strings. */
const PRODUCT_ID = /^[^\s/?#]{1,200}$/;

export function reviewsRoutes(app: FastifyInstance, flaky: () => FlakyOutcome): void {
  app.get<{ Params: { productId: string } }>("/v1/reviews/:productId", async (request, reply) => {
    const { productId } = request.params;
    if (!PRODUCT_ID.test(productId)) return reply.code(400).send({ error: "invalid_request", message: "Invalid product id" });

    const outcome = flaky();
    if (outcome === "error") return reply.code(500).send({ error: "internal_error", message: "Review index timed out" });
    if (outcome === "empty") {
      return {
        product_id: productId,
        rating: null,
        count: 0,
        distribution: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
        highlights: { pros: [], cons: [] },
        reviews: [],
      } satisfies ReviewsSummary;
    }
    const summary = reviewsFor(productId);
    if (outcome === "malformed") {
      // Cut the document short: valid-looking JSON that never closes.
      const json = JSON.stringify(summary);
      return reply.header("content-type", "application/json; charset=utf-8").send(json.slice(0, Math.max(24, Math.floor(json.length * 0.6))));
    }
    return summary;
  });
}
