import { describe, it, expect } from "vitest";
import { intentProbability, timing, isFastLane } from "./scoring.js";

describe("intentProbability", () => {
  it("reproduces the Ledgerly walkthrough (~0.79)", () => {
    // base 2%; strongest (founding AE) +1.79 in full; four others total +4.91 raw -> +3.44 after 70% dampening
    const p = intentProbability(0.02, [
      { lr: Math.exp(1.79), ageDays: 0, halfLifeDays: 1e9 },
      ...[1, 2, 3, 4].map(() => ({ lr: Math.exp(1.2275), ageDays: 0, halfLifeDays: 1e9 })),
    ]);
    expect(p).toBeGreaterThan(0.78);
    expect(p).toBeLessThan(0.8);
  });
  it("missing evidence does not subtract", () => {
    expect(intentProbability(0.02, [])).toBeCloseTo(0.02, 5);
  });
  it("negative signals subtract", () => {
    const base = intentProbability(0.1, [{ lr: 4, ageDays: 0, halfLifeDays: 30 }]);
    const neg = intentProbability(0.1, [
      { lr: 4, ageDays: 0, halfLifeDays: 30 },
      { lr: 0.25, ageDays: 0, halfLifeDays: 30 },
    ]);
    expect(neg).toBeLessThan(base);
  });
  it("old signals decay", () => {
    const fresh = intentProbability(0.05, [{ lr: 6, ageDays: 0, halfLifeDays: 14 }]);
    const old = intentProbability(0.05, [{ lr: 6, ageDays: 28, halfLifeDays: 14 }]);
    expect(old).toBeLessThan(fresh);
  });
});

describe("timing / fast lane", () => {
  it("halves every 14 days", () => expect(timing(14)).toBeCloseTo(0.5));
  it("explicit intent is fast lane", () => expect(isFastLane({ explicitIntent: true, maxStrength: 3 })).toBe(true));
  it("weak single signal is not", () => expect(isFastLane({ explicitIntent: false, maxStrength: 3 })).toBe(false));
});
