/** Node-only: Ed25519 signing and verification of x402 IOU vouchers. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import type { SignedVoucher, Voucher } from "./x402";

export interface AgentKeyPair {
  /** base64url raw 32-byte Ed25519 public key (the JWK "x" member). */
  publicKey: string;
  /** Private key as a JWK JSON string. Never leaves the agent / gateway process. */
  privateKey: string;
}

export function generateAgentKeyPair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  if (!pub.x || !jwk.d) throw new Error("Failed to export Ed25519 key");
  return { publicKey: pub.x, privateKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d }) };
}

/** Deterministic JSON: object keys sorted, no whitespace, undefined members dropped. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function base64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function randomNonce(): string {
  return base64url(randomBytes(16));
}

/**
 * Hash that binds a voucher to one specific request:
 * base64url(SHA-256(METHOD + "\n" + pathWithQuery + "\n" + hex(SHA-256(body)))).
 */
export function requestHash(method: string, pathWithQuery: string, body?: string | Uint8Array | null): string {
  const bodyHash = createHash("sha256")
    .update(body ?? "")
    .digest("hex");
  return createHash("sha256").update(`${method.toUpperCase()}\n${pathWithQuery}\n${bodyHash}`).digest("base64url");
}

export function signVoucher(voucher: Voucher, privateKeyJwk: string): SignedVoucher {
  const key = createPrivateKey({ key: JSON.parse(privateKeyJwk), format: "jwk" });
  const sig = sign(null, Buffer.from(canonicalJson(voucher)), key);
  return { voucher, sig: base64url(sig) };
}

export function verifyVoucher(signed: SignedVoucher, publicKey: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" });
    return verify(null, Buffer.from(canonicalJson(signed.voucher)), key, Buffer.from(signed.sig, "base64url"));
  } catch {
    return false;
  }
}
