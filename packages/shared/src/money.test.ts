import { describe, expect, it } from "vitest";
import {
  allocateProRata,
  captureFeeCents,
  centsToValue,
  dollarsToMicros,
  effectiveRatePct,
  formatUsd,
  microsToCentsFloor,
  microsToDollarString,
  naiveFeeCents,
  valueToCents,
} from "./money";
import { DEFAULT_POLICY, normalizePolicy } from "./policy";

describe("money", () => {
  it("parses dollars exactly", () => {
    expect(dollarsToMicros("0.005")).toBe(5_000);
    expect(dollarsToMicros("$4.31")).toBe(4_310_000);
    expect(dollarsToMicros(0.25)).toBe(250_000);
    expect(dollarsToMicros("0.0000019")).toBe(1);
    expect(() => dollarsToMicros("abc")).toThrow();
  });

  it("formats micros", () => {
    expect(microsToDollarString(5_000)).toBe("0.005");
    expect(microsToDollarString(4_310_000)).toBe("4.31");
    expect(microsToDollarString(0)).toBe("0.00");
    expect(formatUsd(1_234_560_000)).toBe("$1,234.56");
    expect(formatUsd(100)).toBe("$0.0001");
  });

  it("converts cents and PayPal values", () => {
    expect(centsToValue(431)).toBe("4.31");
    expect(centsToValue(5)).toBe("0.05");
    expect(valueToCents("4.31")).toBe(431);
    expect(microsToCentsFloor(4_315_000)).toEqual({ cents: 431, remainderMicros: 5_000 });
  });

  it("computes PayPal capture fees like the published rates", () => {
    expect(captureFeeCents(500)).toBe(66); // $5 tab -> $0.66
    expect(captureFeeCents(2_500)).toBe(136); // $25 -> $1.36
    expect(captureFeeCents(5_000)).toBe(224); // $50 -> $2.24
    expect(captureFeeCents(10_000)).toBe(398); // $100 -> $3.98
    expect(captureFeeCents(500, "micropayments")).toBe(34); // $5 -> $0.34
    expect(captureFeeCents(0)).toBe(0);
    expect(effectiveRatePct(224, 5_000)).toBe(4.48);
  });

  it("computes the per-call fee comparison", () => {
    // 1,000 calls at $0.005 would cost ~$490 in fixed fees alone
    expect(naiveFeeCents(1_000, 5_000_000)).toBe(49_017);
  });

  it("allocates pro rata and always sums to the total", () => {
    const parts = allocateProRata(224, { a: 2_000_000, b: 3_000_000 });
    expect(parts.a + parts.b).toBe(224);
    expect(parts).toEqual({ a: 90, b: 134 });
    const odd = allocateProRata(10, { x: 1, y: 1, z: 1 });
    expect(odd.x + odd.y + odd.z).toBe(10);
    expect(allocateProRata(5, {})).toEqual({});
  });
});

describe("policy", () => {
  it("normalizes and clamps", () => {
    const p = normalizePolicy({ holdCents: 2_000, closeAtCents: 9_000, dailyCapMicros: 999_000_000 });
    expect(p.closeAtCents).toBe(2_000);
    expect(p.dailyCapMicros).toBe(20_000_000);
    expect(p.alarms).toEqual(DEFAULT_POLICY.alarms);
    expect(normalizePolicy({ allowedSellers: [] }).allowedSellers).toEqual(["*"]);
  });
});
