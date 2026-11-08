/** Turn a shopping task into a search query and a price limit: "quiet espresso machine under $500". */

export interface ParsedTask {
  query: string;
  /** Price limit from the task ("under $500", "max $150", "$80 or less"), in cents. */
  maxPriceCents: number | null;
}

const AMOUNT = String.raw`\$?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?(?:\s*(?:usd|dollars?|bucks))?`;
const PRICE_LIMITS = [
  new RegExp(String.raw`(?:under|below|less than|at most|no more than|not more than|max(?:imum)?|up to|within|cheaper than|budget(?: of| is)?)\s*:?\s*${AMOUNT}`, "i"),
  new RegExp(String.raw`(?:<=?|≤)\s*${AMOUNT}`, "i"),
  new RegExp(String.raw`\$\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(k\b)?\s*(?:or less|or under|max|tops|budget)`, "i"),
];

const FILLER = new Set(
  (
    "find buy get me a an the for to with i we us need want looking look please best good great some my our that which " +
    "is are and or of in on at new cheap affordable recommend can you help purchase order shop shopping research " +
    "compare something one should would like"
  ).split(" "),
);

export function parseTask(task: string): ParsedTask {
  let maxPriceCents: number | null = null;
  let rest = task;
  for (const pattern of PRICE_LIMITS) {
    const match = pattern.exec(task);
    if (!match?.[1]) continue;
    const dollars = Number(match[1].replace(/,/g, "")) * (match[2] ? 1_000 : 1);
    if (Number.isFinite(dollars) && dollars > 0) {
      maxPriceCents = Math.round(dollars * 100);
      rest = task.replace(match[0], " ");
      break;
    }
  }
  const words = rest
    .toLowerCase()
    .replace(/[^a-z0-9&\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && w !== "-" && !FILLER.has(w) && !/^\d+$/.test(w));
  const query = words.slice(0, 8).join(" ") || task.trim().slice(0, 80) || "products";
  return { query, maxPriceCents };
}

/** A shorter query for a second try when the first search finds nothing (drops trailing context, then the adjective). */
export function broaden(query: string): string {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length > 3) return words.slice(0, 3).join(" ");
  return words.length > 1 ? words.slice(1).join(" ") : query;
}
