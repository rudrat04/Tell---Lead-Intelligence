import { describe, it, expect } from "vitest";
import { featurize, cosine, gate2Decide, GATE2_DIMS, type Exemplar } from "./gate2.js";

const bank = (pos: string[], neg: string[]): Exemplar[] => [...pos.map((t) => ({ vec: featurize(t), label: "pos" as const })), ...neg.map((t) => ({ vec: featurize(t), label: "neg" as const }))];
const cfg = { mode: "enforce" as const, min_exemplars: 1, drop_margin: 0.15, drop_min_similarity: 0.35 };

describe("gate 2", () => {
  it("vectors are 384-dim, unit length and deterministic", () => {
    const v = featurize("Need help setting up HubSpot lead routing");
    expect(v).toHaveLength(GATE2_DIMS);
    expect(Math.abs(cosine(v, v) - 1)).toBeLessThan(1e-9);
    expect(featurize("Need help setting up HubSpot lead routing")).toEqual(v);
  });
  it("drops a near copy of a bad example, keeps a near copy of a good one", () => {
    const b = bank(["Looking for a freelancer to set up HubSpot lead routing and lifecycle stages"], ["I'm a freelance HubSpot consultant available for new projects, DM me for rates"]);
    expect(gate2Decide("Freelance HubSpot consultant here, available for new projects. DM me for my rates!", b, cfg).pass).toBe(false);
    expect(gate2Decide("We're looking for a freelancer to set up HubSpot lead routing for our team", b, cfg).pass).toBe(true);
  });
  it("shadow mode never drops, and enforce needs enough examples on each side", () => {
    const b = bank(["need hubspot help"], ["freelance hubspot consultant available dm me rates"]);
    const bad = "freelance hubspot consultant available, dm me for rates";
    expect(gate2Decide(bad, b, { ...cfg, mode: "shadow" })).toMatchObject({ pass: true, enforced: false });
    expect(gate2Decide(bad, b, { ...cfg, mode: "shadow" }).reason).toContain("would drop");
    expect(gate2Decide(bad, b, { ...cfg, min_exemplars: 20 }).enforced).toBe(false);
  });
});
