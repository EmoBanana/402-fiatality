import { describe, expect, it } from "vitest";
import { decodeX402Header, encodeX402Header } from "./headers";
import { canonicalJson, generateAgentKeyPair, randomNonce, requestHash, signVoucher, verifyVoucher } from "./voucher";
import type { Voucher } from "./x402";

function voucher(overrides: Partial<Voucher> = {}): Voucher {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    tab: "tab_test",
    seller: "channel3",
    seq: 1,
    price: "5000",
    cumulative: "5000",
    reqHash: requestHash("POST", "/v1/search", JSON.stringify({ query: "espresso" })),
    agent: "agt_1",
    iat: now,
    exp: now + 60,
    nonce: randomNonce(),
    ...overrides,
  };
}

describe("vouchers", () => {
  it("signs and verifies", () => {
    const keys = generateAgentKeyPair();
    const signed = signVoucher(voucher(), keys.privateKey);
    expect(verifyVoucher(signed, keys.publicKey)).toBe(true);
  });

  it("rejects tampering and wrong keys", () => {
    const keys = generateAgentKeyPair();
    const other = generateAgentKeyPair();
    const signed = signVoucher(voucher(), keys.privateKey);
    expect(verifyVoucher({ ...signed, voucher: { ...signed.voucher, cumulative: "1" } }, keys.publicKey)).toBe(false);
    expect(verifyVoucher(signed, other.publicKey)).toBe(false);
    expect(verifyVoucher({ ...signed, sig: "garbage" }, keys.publicKey)).toBe(false);
  });

  it("canonicalizes key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, z: undefined })).toBe(
      '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}',
    );
  });

  it("binds request hashes to method, path and body", () => {
    const a = requestHash("POST", "/v1/search", "{}");
    expect(requestHash("post", "/v1/search", "{}")).toBe(a);
    expect(requestHash("POST", "/v1/search?x=1", "{}")).not.toBe(a);
    expect(requestHash("POST", "/v1/search", '{"q":1}')).not.toBe(a);
  });

  it("round-trips x402 headers", () => {
    const value = { x402Version: 2, hello: "wörld" };
    expect(decodeX402Header(encodeX402Header(value))).toEqual(value);
    expect(decodeX402Header("%%%")).toBeNull();
  });
});
