/**
 * Product images for the demo catalog: small SVG monogram tiles as data URIs, so they render offline and
 * under a default `img-src 'self' data:` CSP without hosting anything.
 */
import { CATEGORIES, type CatalogProduct, type CategoryKey } from "./catalog";

const PALETTE: Record<CategoryKey, { bg: string; ink: string }> = {
  espresso: { bg: "#F4ECE3", ink: "#6B3E1F" },
  headphones: { bg: "#EEF2F9", ink: "#1D3A6E" },
  desks: { bg: "#ECF3EC", ink: "#2F5D3A" },
  shoes: { bg: "#F8ECEA", ink: "#8A2E22" },
};

function initials(brand: string): string {
  const words = brand.split(/[^A-Za-z]+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

export function productImageUrl(product: CatalogProduct): string {
  const { bg, ink } = PALETTE[product.category];
  const label = CATEGORIES[product.category].title;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='480' viewBox='0 0 480 480'>` +
    `<rect width='480' height='480' fill='${bg}'/>` +
    `<text x='240' y='262' font-family='Inter,Helvetica,Arial,sans-serif' font-size='132' font-weight='600' fill='${ink}' text-anchor='middle'>${initials(product.brand)}</text>` +
    `<text x='240' y='338' font-family='Inter,Helvetica,Arial,sans-serif' font-size='26' fill='${ink}' fill-opacity='0.7' text-anchor='middle'>${label}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
