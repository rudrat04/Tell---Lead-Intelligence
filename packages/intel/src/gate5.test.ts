import { describe, it, expect } from "vitest";
import { corroborated, type ConfirmedSignal } from "./gate5.js";

const d = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const s = (cls: ConfirmedSignal["class"], clusterId: string, day = 0, fastLane = false): ConfirmedSignal => ({ class: cls, type: "t", observedAt: d(day), clusterId, fastLane });

describe("gate5", () => {
  it("explicit passes alone", () => expect(corroborated(s("explicit", "a"), [])).toBe(true));
  it("lone trigger is held", () => expect(corroborated(s("trigger", "a"), [])).toBe(false));
  it("trigger + implicit passes", () => expect(corroborated(s("trigger", "a"), [s("implicit", "b", 5)])).toBe(true));
  it("two independent triggers pass", () => expect(corroborated(s("trigger", "a"), [s("pain", "b", 10)])).toBe(true));
  it("copies of the same event do not corroborate", () => expect(corroborated(s("trigger", "a"), [s("trigger", "a", 1)])).toBe(false));
  it("signals outside 30 days do not count", () => expect(corroborated(s("trigger", "a"), [s("implicit", "b", 45)])).toBe(false));
});
