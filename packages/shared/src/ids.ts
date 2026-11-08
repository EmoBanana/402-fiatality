const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Random, URL-safe id with a readable prefix: newId("tab") -> "tab_k3x9q2m1v8p0w7". */
export function newId(prefix: string, length = 16): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return `${prefix}_${out}`;
}

/** Lowercase slug for seller ids: "Price Watch!" -> "price-watch". */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export const SELLER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
