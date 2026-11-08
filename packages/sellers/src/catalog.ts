/**
 * The demo product catalog: 40 fictional products in four categories. Brands and merchant domains are
 * invented (merchants use the reserved `.example` TLD). `rating`, `reviewCount` and `trend` are hidden signals
 * that only the reviews and pricewatch sellers reveal, so the agent has a reason to pay for them.
 */

export type CategoryKey = "espresso" | "headphones" | "desks" | "shoes";
export type PriceTrend = "low" | "typical" | "high";

export interface Category {
  key: CategoryKey;
  slug: string;
  title: string;
  path: string[];
  /** Words that find this category in search, besides product text. */
  terms: string[];
}

export interface CatalogOffer {
  domain: string;
  priceCents: number;
  compareAtCents?: number;
  inStock: boolean;
}

export interface CatalogProduct {
  id: string;
  category: CategoryKey;
  title: string;
  brand: string;
  description: string;
  features: string[];
  offers: CatalogOffer[];
  rating: number;
  reviewCount: number;
  trend: PriceTrend;
}

export const CATEGORIES: Record<CategoryKey, Category> = {
  espresso: {
    key: "espresso",
    slug: "espresso-machines",
    title: "Espresso Machines",
    path: ["Home & Kitchen", "Coffee & Tea", "Espresso Machines"],
    terms: ["espresso", "coffee", "machine", "maker", "barista", "cappuccino", "latte"],
  },
  headphones: {
    key: "headphones",
    slug: "headphones",
    title: "Headphones",
    path: ["Electronics", "Audio", "Headphones"],
    terms: ["headphones", "earbuds", "earphones", "headset", "audio"],
  },
  desks: {
    key: "desks",
    slug: "standing-desks",
    title: "Standing Desks",
    path: ["Home & Office", "Furniture", "Standing Desks"],
    terms: ["desk", "standing", "sit-stand", "adjustable", "office", "workstation", "ergonomic"],
  },
  shoes: {
    key: "shoes",
    slug: "running-shoes",
    title: "Running Shoes",
    path: ["Clothing, Shoes & Jewelry", "Shoes", "Running Shoes"],
    terms: ["running", "shoes", "sneakers", "trainers", "runners", "jogging", "marathon"],
  },
};

/** Affiliate commission each fictional merchant pays (Channel3's `max_commission_rate`). */
export const MERCHANT_COMMISSION: Record<string, number> = {
  "homebarista.example": 0.06,
  "kitchenloft.example": 0.05,
  "brewsupply.example": 0.07,
  "everymart.example": 0.03,
  "soundhaus.example": 0.06,
  "audiolane.example": 0.08,
  "deskcraft.example": 0.07,
  "workwell.example": 0.05,
  "strideshop.example": 0.08,
  "runnersdepot.example": 0.06,
};

function offer(domain: string, dollars: number, opts: { was?: number; out?: boolean } = {}): CatalogOffer {
  return {
    domain,
    priceCents: Math.round(dollars * 100),
    ...(opts.was ? { compareAtCents: Math.round(opts.was * 100) } : {}),
    inStock: !opts.out,
  };
}

export const PRODUCTS: CatalogProduct[] = [
  // ------------------------------------------------------------ espresso machines
  {
    id: "esp-1001", category: "espresso", brand: "Brewline", title: "Brewline Barista Pro Espresso Machine",
    description: "Semi-automatic espresso machine with PID temperature control and a commercial-style steam wand for cafe-quality microfoam at home.",
    features: ["15-bar Italian pump", "PID temperature control", "Commercial-style steam wand", "58 mm portafilter", "2 L removable water tank"],
    offers: [offer("homebarista.example", 449, { was: 529 }), offer("kitchenloft.example", 469)],
    rating: 4.7, reviewCount: 1284, trend: "low",
  },
  {
    id: "esp-1002", category: "espresso", brand: "Brewline", title: "Brewline Compact 15-Bar Espresso Maker",
    description: "A small-footprint espresso maker that heats up in 40 seconds, with a manual frother for lattes.",
    features: ["15-bar pump", "40-second heat-up", "Manual milk frother", "6-inch wide footprint"],
    offers: [offer("everymart.example", 179), offer("homebarista.example", 189)],
    rating: 4.2, reviewCount: 2310, trend: "typical",
  },
  {
    id: "esp-1003", category: "espresso", brand: "Caffora", title: "Caffora Duetto Dual Boiler Espresso Machine",
    description: "Prosumer dual-boiler machine: brew and steam at the same time, with a rotary pump that stays quiet.",
    features: ["Dual stainless steel boilers", "E61 group head", "Quiet rotary pump", "Shot timer and pressure gauge"],
    offers: [offer("homebarista.example", 1299), offer("brewsupply.example", 1349)],
    rating: 4.8, reviewCount: 412, trend: "typical",
  },
  {
    id: "esp-1004", category: "espresso", brand: "Caffora", title: "Caffora Piccolo Super-Automatic Espresso Machine",
    description: "Bean-to-cup machine with a built-in conical burr grinder and one-touch cappuccino.",
    features: ["Built-in conical burr grinder", "One-touch cappuccino", "13 grind settings", "Self-cleaning milk system"],
    offers: [offer("kitchenloft.example", 699)],
    rating: 4.3, reviewCount: 876, trend: "high",
  },
  {
    id: "esp-1005", category: "espresso", brand: "Steamwell", title: "Steamwell Quiet Brew Espresso Machine",
    description: "Vibration-damped espresso machine built for open-plan homes and small offices: about as loud as a conversation.",
    features: ["Whisper-quiet 52 dB operation", "Thermoblock heats in 25 seconds", "Auto-purge steam wand", "Cup warmer"],
    offers: [offer("homebarista.example", 329), offer("everymart.example", 319, { out: true })],
    rating: 4.5, reviewCount: 954, trend: "low",
  },
  {
    id: "esp-1006", category: "espresso", brand: "Steamwell", title: "Steamwell Cafe Latte Station",
    description: "Automatic latte machine with a milk carafe and programmable single and double shots.",
    features: ["Automatic milk carafe", "19-bar pump", "Programmable shots", "Removable drip tray"],
    offers: [offer("kitchenloft.example", 249)],
    rating: 3.9, reviewCount: 1640, trend: "typical",
  },
  {
    id: "esp-1007", category: "espresso", brand: "Vespera", title: "Vespera Lever Classic Manual Espresso Maker",
    description: "Spring-lever espresso machine for hands-on pressure profiling, in chrome-plated brass.",
    features: ["Spring-lever piston", "Chrome-plated brass group", "1.8 L boiler", "Manual pressure profiling"],
    offers: [offer("brewsupply.example", 899)],
    rating: 4.6, reviewCount: 231, trend: "high",
  },
  {
    id: "esp-1008", category: "espresso", brand: "Vespera", title: "Vespera Mini Espresso Machine",
    description: "Entry-level espresso machine with pressurized baskets that fits under kitchen cabinets.",
    features: ["20-bar pump", "Pressurized baskets", "Fits under cabinets", "Auto shut-off"],
    offers: [offer("everymart.example", 139), offer("kitchenloft.example", 149)],
    rating: 3.6, reviewCount: 3105, trend: "typical",
  },
  {
    id: "esp-1009", category: "espresso", brand: "Moka & Co", title: "Moka & Co Heritage Espresso Machine with Grinder",
    description: "All-in-one espresso machine with an integrated burr grinder, dose control and a dedicated hot water outlet.",
    features: ["Integrated burr grinder, 30 settings", "Dose control", "Steam wand", "Hot water outlet"],
    offers: [offer("homebarista.example", 599, { was: 649 }), offer("brewsupply.example", 629)],
    rating: 4.4, reviewCount: 1022, trend: "low",
  },
  {
    id: "esp-1010", category: "espresso", brand: "Moka & Co", title: "Moka & Co Pod and Ground Espresso Maker",
    description: "Budget espresso maker that takes pods or ground coffee and is ready in 30 seconds.",
    features: ["Pods or ground coffee", "15-bar pump", "30-second heat-up", "Auto shut-off"],
    offers: [offer("everymart.example", 129)],
    rating: 4.0, reviewCount: 1876, trend: "typical",
  },

  // ------------------------------------------------------------ headphones
  {
    id: "hp-2001", category: "headphones", brand: "Aurelle", title: "Aurelle Studio ANC Wireless Headphones",
    description: "Over-ear wireless headphones with adaptive noise cancelling, multipoint Bluetooth and a 40-hour battery.",
    features: ["Adaptive noise cancelling", "40-hour battery", "Multipoint Bluetooth 5.4", "Memory-foam ear cushions"],
    offers: [offer("soundhaus.example", 349), offer("audiolane.example", 329, { was: 379 })],
    rating: 4.6, reviewCount: 2104, trend: "low",
  },
  {
    id: "hp-2002", category: "headphones", brand: "Aurelle", title: "Aurelle Air Buds Pro Wireless Earbuds",
    description: "Noise-cancelling wireless earbuds with a wireless charging case and IPX4 sweat resistance.",
    features: ["Active noise cancelling", "IPX4 sweat resistant", "Wireless charging case", "7 h + 28 h with case"],
    offers: [offer("audiolane.example", 179)],
    rating: 4.3, reviewCount: 3512, trend: "typical",
  },
  {
    id: "hp-2003", category: "headphones", brand: "Hushline", title: "Hushline Q40 Noise Cancelling Wireless Headphones",
    description: "Hybrid noise-cancelling headphones with four microphones, 45-hour battery and fast USB-C charging.",
    features: ["Hybrid ANC with 4 microphones", "45-hour battery", "Fold-flat design", "10 min charge = 5 h playback"],
    offers: [offer("soundhaus.example", 229), offer("everymart.example", 219)],
    rating: 4.5, reviewCount: 1689, trend: "typical",
  },
  {
    id: "hp-2004", category: "headphones", brand: "Hushline", title: "Hushline Q20 Wireless Headphones",
    description: "Lightweight wireless headphones with a 50-hour battery and a built-in microphone for calls.",
    features: ["50-hour battery", "Bluetooth 5.3", "Built-in microphone", "Foldable"],
    offers: [offer("everymart.example", 99)],
    rating: 4.0, reviewCount: 4230, trend: "low",
  },
  {
    id: "hp-2005", category: "headphones", brand: "Tonfield", title: "Tonfield Reference Open-Back Headphones",
    description: "Wired open-back planar headphones for critical listening at a desk.",
    features: ["50 mm planar drivers", "Open-back soundstage", "Detachable cable", "Velour ear pads"],
    offers: [offer("audiolane.example", 449)],
    rating: 4.8, reviewCount: 318, trend: "typical",
  },
  {
    id: "hp-2006", category: "headphones", brand: "Tonfield", title: "Tonfield Commute ANC Wireless Headphones",
    description: "Travel headphones with noise cancelling, a transparency mode and a hard carry case.",
    features: ["Active noise cancelling", "Transparency mode", "30-hour battery", "Hard carry case"],
    offers: [offer("soundhaus.example", 199, { out: true }), offer("audiolane.example", 209)],
    rating: 4.2, reviewCount: 902, trend: "high",
  },
  {
    id: "hp-2007", category: "headphones", brand: "Pellucid", title: "Pellucid Sport Wireless Earbuds",
    description: "Waterproof sport earbuds with secure ear hooks for running and the gym.",
    features: ["Secure ear hooks", "IP67 waterproof", "10-hour battery", "Quick pair"],
    offers: [offer("everymart.example", 69)],
    rating: 3.8, reviewCount: 2877, trend: "typical",
  },
  {
    id: "hp-2008", category: "headphones", brand: "Pellucid", title: "Pellucid Halo Over-Ear Wireless Headphones",
    description: "Light over-ear headphones with noise cancelling and spatial audio at a mid-range price.",
    features: ["Active noise cancelling", "35-hour battery", "Spatial audio", "Weighs 250 g"],
    offers: [offer("soundhaus.example", 149), offer("everymart.example", 159)],
    rating: 4.1, reviewCount: 1244, trend: "low",
  },
  {
    id: "hp-2009", category: "headphones", brand: "Aurelle", title: "Aurelle Studio Wired Monitor Headphones",
    description: "Closed-back studio monitor headphones with swiveling ear cups and two cables.",
    features: ["Closed-back", "45 mm drivers", "Coiled and straight cables", "Swiveling ear cups"],
    offers: [offer("audiolane.example", 129)],
    rating: 4.4, reviewCount: 760, trend: "typical",
  },
  {
    id: "hp-2010", category: "headphones", brand: "Hushline", title: "Hushline Q60 Premium ANC Wireless Headphones",
    description: "Flagship noise-cancelling headphones with lossless USB-C audio and an aluminum headband.",
    features: ["Adaptive ANC", "Lossless USB-C audio", "60-hour battery", "Aluminum headband"],
    offers: [offer("soundhaus.example", 399)],
    rating: 4.4, reviewCount: 540, trend: "high",
  },

  // ------------------------------------------------------------ standing desks
  {
    id: "desk-3001", category: "desks", brand: "Liftwell", title: "Liftwell Pro Dual-Motor Standing Desk 60x30",
    description: "Dual-motor electric standing desk with a 355 lb capacity, four memory presets and anti-collision.",
    features: ["Dual motors, 355 lb capacity", "Height 24.5 to 50 in", "4 memory presets", "Anti-collision sensor"],
    offers: [offer("deskcraft.example", 649), offer("workwell.example", 679)],
    rating: 4.7, reviewCount: 1120, trend: "typical",
  },
  {
    id: "desk-3002", category: "desks", brand: "Liftwell", title: "Liftwell Essential Standing Desk 48x24",
    description: "Single-motor electric standing desk sized for apartments and home offices.",
    features: ["Single motor, 175 lb capacity", "Height 28 to 47 in", "2 memory presets", "Tool-free top assembly"],
    offers: [offer("workwell.example", 299)],
    rating: 4.2, reviewCount: 2034, trend: "low",
  },
  {
    id: "desk-3003", category: "desks", brand: "Oakmere", title: "Oakmere Solid Walnut Standing Desk 60x30",
    description: "Solid walnut standing desk on a dual-motor frame with a cable tray and a 10-year warranty.",
    features: ["Solid walnut top", "Dual motors", "Cable tray included", "10-year frame warranty"],
    offers: [offer("deskcraft.example", 1199)],
    rating: 4.8, reviewCount: 205, trend: "typical",
  },
  {
    id: "desk-3004", category: "desks", brand: "Oakmere", title: "Oakmere Bamboo Standing Desk 55x28",
    description: "Bamboo-top electric standing desk with three-stage legs for tall users.",
    features: ["Bamboo top", "Dual motors", "Height 25 to 50.5 in", "Three-stage legs"],
    offers: [offer("deskcraft.example", 749), offer("everymart.example", 729, { out: true })],
    rating: 4.5, reviewCount: 468, trend: "high",
  },
  {
    id: "desk-3005", category: "desks", brand: "Stancework", title: "Stancework Corner L-Shaped Standing Desk",
    description: "L-shaped corner standing desk with three motors for multi-monitor setups.",
    features: ["L-shaped 63 x 55 in", "Triple motors", "400 lb capacity", "4 memory presets"],
    offers: [offer("workwell.example", 899)],
    rating: 4.3, reviewCount: 312, trend: "low",
  },
  {
    id: "desk-3006", category: "desks", brand: "Stancework", title: "Stancework Compact Standing Desk 40x24",
    description: "Compact electric standing desk for small rooms, with a USB-C charging port.",
    features: ["Fits small rooms", "Single motor", "USB-C charging port", "Height 29 to 46 in"],
    offers: [offer("everymart.example", 249)],
    rating: 3.9, reviewCount: 1566, trend: "typical",
  },
  {
    id: "desk-3007", category: "desks", brand: "Uprise Studio", title: "Uprise Studio Electric Standing Desk 55x28",
    description: "Quiet dual-motor standing desk with a wide height range and a child lock.",
    features: ["Dual motors", "Height 25 to 51 in", "Whisper-quiet 45 dB motors", "Child lock"],
    offers: [offer("deskcraft.example", 449), offer("workwell.example", 469)],
    rating: 4.5, reviewCount: 2876, trend: "low",
  },
  {
    id: "desk-3008", category: "desks", brand: "Uprise Studio", title: "Uprise Studio Standing Desk Converter 32 in",
    description: "Gas-spring converter that turns an existing desk into a sit-stand workstation.",
    features: ["Sits on your current desk", "Gas-spring lift", "Keyboard tray", "No assembly"],
    offers: [offer("everymart.example", 199)],
    rating: 4.1, reviewCount: 3940, trend: "typical",
  },
  {
    id: "desk-3009", category: "desks", brand: "Liftwell", title: "Liftwell Treadmill-Ready Standing Desk 63x30",
    description: "Extra-wide dual-motor standing desk that rises high enough for a walking pad.",
    features: ["Extra-wide 63 x 30 in top", "Dual motors", "50.5 in maximum height", "Cable spine"],
    offers: [offer("workwell.example", 799)],
    rating: 4.4, reviewCount: 377, trend: "high",
  },
  {
    id: "desk-3010", category: "desks", brand: "Oakmere", title: "Oakmere Manual Crank Standing Desk 48x24",
    description: "Hand-crank standing desk that needs no power outlet, on a steel frame.",
    features: ["Hand crank, no power needed", "Steel frame", "Height 28 to 45 in", "Locking casters"],
    offers: [offer("deskcraft.example", 349)],
    rating: 3.7, reviewCount: 690, trend: "typical",
  },

  // ------------------------------------------------------------ running shoes
  {
    id: "run-4001", category: "shoes", brand: "Stridewell", title: "Stridewell Cloudline 3 Road Running Shoe",
    description: "Cushioned daily road running shoe with a nitrogen-infused foam midsole.",
    features: ["Nitrogen-infused foam midsole", "8 mm drop", "Engineered mesh upper", "9.1 oz (men's 9)"],
    offers: [offer("strideshop.example", 139), offer("runnersdepot.example", 129, { was: 139 })],
    rating: 4.6, reviewCount: 2450, trend: "low",
  },
  {
    id: "run-4002", category: "shoes", brand: "Stridewell", title: "Stridewell Velocity Carbon Racing Shoe",
    description: "Race-day shoe with a full-length carbon plate and PEBA foam.",
    features: ["Full-length carbon plate", "PEBA foam", "7.2 oz", "6 mm drop"],
    offers: [offer("runnersdepot.example", 229)],
    rating: 4.5, reviewCount: 812, trend: "typical",
  },
  {
    id: "run-4003", category: "shoes", brand: "Northpace", title: "Northpace Trail Ridge Waterproof Trail Running Shoe",
    description: "Waterproof trail running shoe with 5 mm lugs and a rock plate.",
    features: ["Waterproof membrane", "5 mm lugs", "Rock plate", "Gusseted tongue"],
    offers: [offer("strideshop.example", 159), offer("everymart.example", 165)],
    rating: 4.4, reviewCount: 1330, trend: "typical",
  },
  {
    id: "run-4004", category: "shoes", brand: "Northpace", title: "Northpace Daily Trainer 2 Running Shoe",
    description: "Durable, affordable daily trainer available in wide sizes.",
    features: ["EVA midsole", "Durable rubber outsole", "10 mm drop", "Wide sizes available"],
    offers: [offer("everymart.example", 99), offer("strideshop.example", 109)],
    rating: 4.1, reviewCount: 3870, trend: "low",
  },
  {
    id: "run-4005", category: "shoes", brand: "Lumen Run", title: "Lumen Run Glide Max Cushioned Running Shoe",
    description: "Max-cushion running shoe with a rocker geometry for long, easy miles.",
    features: ["40 mm max-cushion stack", "Rocker geometry", "Reflective details", "Knit upper"],
    offers: [offer("runnersdepot.example", 169)],
    rating: 4.7, reviewCount: 1045, trend: "high",
  },
  {
    id: "run-4006", category: "shoes", brand: "Lumen Run", title: "Lumen Run Pace Lite Running Shoe",
    description: "Lightweight budget running shoe with a breathable mesh upper.",
    features: ["7.8 oz", "Breathable mesh upper", "Flexible outsole"],
    offers: [offer("everymart.example", 89)],
    rating: 3.8, reviewCount: 2210, trend: "typical",
  },
  {
    id: "run-4007", category: "shoes", brand: "Cadenza", title: "Cadenza Stability 12 Running Shoe",
    description: "Stability running shoe with guide rails for overpronation and a wide toe box.",
    features: ["Guide rails for overpronation", "Dual-density foam", "12 mm drop", "Wide toe box"],
    offers: [offer("strideshop.example", 149), offer("runnersdepot.example", 139, { out: true })],
    rating: 4.5, reviewCount: 1602, trend: "typical",
  },
  {
    id: "run-4008", category: "shoes", brand: "Cadenza", title: "Cadenza Trail Sprint Running Shoe",
    description: "Nimble trail shoe with sticky rubber lugs and a quick-lace system.",
    features: ["Sticky rubber lugs", "Quick-lace system", "8 mm drop"],
    offers: [offer("runnersdepot.example", 119)],
    rating: 4.0, reviewCount: 744, trend: "low",
  },
  {
    id: "run-4009", category: "shoes", brand: "Stridewell", title: "Stridewell Cloudline Trail Running Shoe",
    description: "The Cloudline ride with an all-terrain outsole and a toe bumper.",
    features: ["All-terrain outsole", "Cushioned foam midsole", "Toe bumper"],
    offers: [offer("strideshop.example", 149)],
    rating: 4.3, reviewCount: 520, trend: "typical",
  },
  {
    id: "run-4010", category: "shoes", brand: "Northpace", title: "Northpace Marathon Elite Running Shoe",
    description: "Marathon racer with a carbon-infused plate and supercritical foam.",
    features: ["Carbon-infused plate", "Supercritical foam", "8 mm drop", "Race-day fit"],
    offers: [offer("runnersdepot.example", 199), offer("strideshop.example", 209)],
    rating: 4.6, reviewCount: 689, trend: "high",
  },
];

const BY_ID = new Map(PRODUCTS.map((p) => [p.id, p]));

export function findProduct(id: string): CatalogProduct | undefined {
  return BY_ID.get(id);
}

/** Cheapest in-stock offer, else the cheapest offer. */
export function bestOffer(product: CatalogProduct): CatalogOffer {
  const sorted = [...product.offers].sort((a, b) => Number(b.inStock) - Number(a.inStock) || a.priceCents - b.priceCents);
  const first = sorted[0];
  if (!first) throw new Error(`Product ${product.id} has no offers`);
  return first;
}
