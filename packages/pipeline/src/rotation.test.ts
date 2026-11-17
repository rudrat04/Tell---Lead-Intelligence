import { describe, it, expect } from "vitest";
import { rotatingSlice } from "./watch.js";
import { pickRotating } from "./discover-jsearch.js";

describe("rotating slices (YC page cap, daily discovery)", () => {
  it("consecutive slices cover the whole list", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const seen = new Set([0, 1, 2, 3].flatMap((k) => rotatingSlice(items, 3, k)));
    expect(seen.size).toBe(10);
    expect(rotatingSlice(items, 20, 1)).toEqual(items);
  });
  it("daily Workable searches rotate across query x location", () => {
    const pairs = ["sales", "crm"].flatMap((q) => ["India", "Singapore"].map((l) => ({ q, l })));
    const d0 = pickRotating(pairs, 2, new Date("2026-11-17T00:00:00Z"));
    const d1 = pickRotating(pairs, 2, new Date("2026-11-18T00:00:00Z"));
    expect(new Set([...d0, ...d1].map((p) => `${p.q}@${p.l}`)).size).toBe(4);
  });
});
