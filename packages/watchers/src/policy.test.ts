import { describe, it, expect } from "vitest";
import { isSourceEnabled, isMappingAllowed } from "./policy.js";

describe("source policy", () => {
  it("Reddit sources are disabled until approved", () => {
    expect(isSourceEnabled("reddit")).toBe(false);
    expect(isSourceEnabled("forhire-subs")).toBe(false);
    expect(isSourceEnabled("hn")).toBe(true);
  });
  it("Reddit authors are never mapped via profiles or other platforms", () => {
    expect(isMappingAllowed("reddit", "explicit")).toBe(true);
    for (const m of ["profile", "cross-platform", "hint"] as const) expect(isMappingAllowed("reddit", m)).toBe(false);
  });
  it("unknown sources default to explicit-only mapping", () => {
    expect(isMappingAllowed("new-source", "cross-platform")).toBe(false);
  });
});
