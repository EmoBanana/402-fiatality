/** Node-only: x402 header encoding (base64 of UTF-8 JSON). */

export function encodeX402Header(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeX402Header<T>(header: string | null | undefined): T | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
  } catch {
    return null;
  }
}
