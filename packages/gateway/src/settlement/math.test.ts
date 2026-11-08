import { captureFeeCents, MICROS_PER_CENT, naiveFeeCents } from "@p402/shared";
import { describe, expect, it } from "vitest";
import { allocateLines, noteToPayer, planSettlement, type SellerGross } from "./math";

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

describe("planSettlement", () => {
  it("floors the charge to cents and carries the sub-cent remainder", () => {
    const sellers: SellerGross[] = [
      { sellerId: "channel3", grossMicros: 3 * 5_000, calls: 3 },
      { sellerId: "pricewatch", grossMicros: 10_000, calls: 1 },
    ];
    expect(planSettlement(sellers, 0)).toEqual({
      billableMicros: 25_000,
      vouchersMicros: 25_000,
      carryInMicros: 0,
      chargedCents: 2,
      carryOutMicros: 5_000,
      callCount: 4,
      naiveFeeCents: naiveFeeCents(4, 25_000),
    });
  });

  it("adds the carry-in before flooring", () => {
    const plan = planSettlement([{ sellerId: "channel3", grossMicros: 25_000, calls: 5 }], 5_000);
    expect(plan).toMatchObject({ billableMicros: 30_000, chargedCents: 3, carryOutMicros: 0 });
  });

  it("charges nothing when no seller earned anything and carries everything", () => {
    expect(planSettlement([], 7_500)).toMatchObject({ chargedCents: 0, carryOutMicros: 7_500, callCount: 0, naiveFeeCents: 0 });
    expect(planSettlement([{ sellerId: "reviews", grossMicros: 3_000, calls: 1 }], 0)).toMatchObject({
      chargedCents: 0,
      carryOutMicros: 3_000,
    });
  });

  it("handles a full $50 tab of $0.005 calls", () => {
    const plan = planSettlement([{ sellerId: "channel3", grossMicros: 10_000 * 5_000, calls: 10_000 }], 0);
    expect(plan.chargedCents).toBe(5_000);
    expect(plan.carryOutMicros).toBe(0);
    expect(captureFeeCents(plan.chargedCents)).toBe(224);
  });
});

describe("allocateLines", () => {
  it("splits the charge and the fee pro rata by gross, net = gross − fee", () => {
    const sellers: SellerGross[] = [
      { sellerId: "pricewatch", grossMicros: 1_000_000, calls: 100 },
      { sellerId: "channel3", grossMicros: 3_000_000, calls: 600 },
    ];
    const lines = allocateLines(sellers, 400, 63);
    expect(lines).toEqual([
      { sellerId: "channel3", calls: 600, grossMicros: 3_000_000, feeShareMicros: 472_500, netMicros: 2_527_500 },
      { sellerId: "pricewatch", calls: 100, grossMicros: 1_000_000, feeShareMicros: 157_500, netMicros: 842_500 },
    ]);
  });

  it("absorbs the carry in/out into the charged gross so the ledger closes exactly", () => {
    // 25,000 µ of vouchers, 2 cents charged: the 5,000 µ remainder is not credited to anyone yet.
    const sellers: SellerGross[] = [
      { sellerId: "channel3", grossMicros: 15_000, calls: 3 },
      { sellerId: "pricewatch", grossMicros: 10_000, calls: 1 },
    ];
    const lines = allocateLines(sellers, 2, 0);
    expect(sum(lines.map((l) => l.grossMicros))).toBe(20_000);
    expect(lines.find((l) => l.sellerId === "channel3")?.grossMicros).toBe(12_000);
  });

  it("keeps the invariant Σ net + Σ fee = charged × 10 000 on random tabs", () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let round = 0; round < 500; round++) {
      const sellers: SellerGross[] = Array.from({ length: 1 + rand(6) }, (_, i) => {
        const calls = 1 + rand(2_000);
        return { sellerId: `s${i}`, grossMicros: calls * (1 + rand(50_000)), calls };
      });
      const plan = planSettlement(sellers, rand(MICROS_PER_CENT));
      const fee = plan.chargedCents > 0 ? captureFeeCents(plan.chargedCents) : 0;
      const lines = allocateLines(sellers, plan.chargedCents, fee);
      const charged = plan.chargedCents * MICROS_PER_CENT;
      expect(sum(lines.map((l) => l.netMicros)) + sum(lines.map((l) => l.feeShareMicros))).toBe(charged);
      expect(sum(lines.map((l) => l.feeShareMicros))).toBe(fee * MICROS_PER_CENT);
      expect(plan.chargedCents * MICROS_PER_CENT + plan.carryOutMicros).toBe(plan.billableMicros);
      expect(plan.carryOutMicros).toBeGreaterThanOrEqual(0);
      expect(plan.carryOutMicros).toBeLessThan(MICROS_PER_CENT);
      for (const line of lines) {
        expect(line.netMicros).toBe(line.grossMicros - line.feeShareMicros);
        const weight = sellers.find((s) => s.sellerId === line.sellerId)!.grossMicros / plan.vouchersMicros;
        expect(Math.abs(line.feeShareMicros - fee * MICROS_PER_CENT * weight)).toBeLessThanOrEqual(1);
        expect(Math.abs(line.grossMicros - charged * weight)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("noteToPayer", () => {
  it("reads naturally", () => {
    expect(noteToPayer(1, 1)).toBe("Agent API usage, 1 call across 1 seller");
    expect(noteToPayer(1_204, 3)).toBe("Agent API usage, 1,204 calls across 3 sellers");
  });
});
