import { describe, expect, it } from "vitest";
import { formatDuration, formatPct, modelLabel, shortId } from "./format";

describe("format", () => {
  it("formats percentages, dropping decimals from 100% up and grouping thousands", () => {
    expect(formatPct(4.4812)).toBe("4.48%");
    expect(formatPct(12.5, 1)).toBe("12.5%");
    expect(formatPct(99.5, 1)).toBe("99.5%");
    expect(formatPct(0, 0)).toBe("0%");
    expect(formatPct(980)).toBe("980%");
    expect(formatPct(983.5, 1)).toBe("984%");
    expect(formatPct(1225)).toBe("1,225%");
    expect(formatPct(4900, 1)).toBe("4,900%");
  });

  it("rolls durations over instead of printing 24 h or 60 min", () => {
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(59_600)).toBe("1 min");
    expect(formatDuration(59.7 * 60_000)).toBe("1 h");
    expect(formatDuration(90 * 60_000)).toBe("1 h 30 min");
    expect(formatDuration(3 * 86_400_000 + 23.9 * 3_600_000)).toBe("4 d");
    expect(formatDuration(2 * 86_400_000 + 5 * 3_600_000)).toBe("2 d 5 h");
    expect(formatDuration(-3_600_000)).toBe("1 h");
  });

  it("labels models and shortens ids", () => {
    expect(modelLabel("gemma4:12b")).toBe("Gemma 4 · 12b");
    expect(shortId("tab_k3x9q2m1v8p0w7")).toBe("tab_k3x9…w7");
  });
});
