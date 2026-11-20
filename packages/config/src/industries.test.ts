import { describe, it, expect } from "vitest";
import { expandIndustries } from "./load.js";

describe("industries.yaml expansion", () => {
  const icp = { hard_filters: { industries_any: ["B2B"], segment_overrides: {} }, segment_map: { B2B: "software" }, segment_descriptions: { software: "sells software to businesses" }, soft_fit: { segment: { software: 1 } } };
  it("adds labels, aliases, descriptions, overrides and fit; excluded industries are described but never admitted", () => {
    const out = expandIndustries(icp, {
      pharma: { label: "Pharma", aliases: ["Generics"], description: "makes generic drugs", regions: ["India"], team_size: { min: 20, max: 2000 }, fit: 1 },
      consumer: { label: "Consumer", description: "sells to consumers", excluded: true },
    });
    expect(out.segment_map).toEqual({ B2B: "software", Pharma: "pharma", Generics: "pharma" });
    expect(out.hard_filters.industries_any).toEqual(["B2B", "Pharma", "Generics"]);
    expect(out.hard_filters.segment_overrides).toEqual({ pharma: { team_size: { min: 20, max: 2000 }, regions_any: ["India"] } });
    expect(out.segment_descriptions.consumer).toBe("sells to consumers");
    expect(out.soft_fit.segment).toEqual({ software: 1, pharma: 1 });
  });
  it("an industry in both files is an error, never a silent merge", () => {
    expect(() => expandIndustries(icp, { software: { label: "Software", description: "sells software too" } })).toThrow(/both industries.yaml and icp.yaml/);
  });
});
