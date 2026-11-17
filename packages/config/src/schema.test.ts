import { describe, it, expect } from "vitest";
import { loadFixturePack } from "./fixture.js";
import { PackSchema } from "./schema.js";

// cross-file names that used to fail silently (neutral fit, no persona) now fail pack:check
describe("pack cross-file checks", () => {
  const base = async () => structuredClone(await loadFixturePack()) as unknown as Record<string, any>;
  const issues = (p: unknown) => {
    const r = PackSchema.safeParse(p);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it("the fixture pack passes", async () => {
    expect(issues(await base())).toEqual([]);
  });
  it("a play naming a persona that doesn't exist", async () => {
    const p = await base();
    const [id] = Object.keys(p.plays.plays);
    p.plays.plays[id!].personas = ["Chief Vibes Officer"];
    expect(issues(p).join()).toMatch(/unknown persona "Chief Vibes Officer"/);
  });
  it("min_count for a type the play doesn't require", async () => {
    const p = await base();
    const [id] = Object.keys(p.plays.plays);
    p.plays.plays[id!].min_count = { not_required_type: 2 };
    expect(issues(p).join()).toMatch(/min_count "not_required_type" is not in requires/);
  });
  it("a size band in soft_fit that the pack doesn't define", async () => {
    const p = await base();
    p.icp.soft_fit.size_band = { ...p.icp.soft_fit.size_band, "9999+": 1 };
    expect(issues(p).join()).toMatch(/unknown size band "9999\+"/);
  });
  it("no lead cap without a score floor", async () => {
    const p = await base();
    p.delivery.digest.max_leads = 0;
    p.delivery.digest.min_score = 0;
    expect(issues(p).join()).toMatch(/max_leads 0 \(no cap\) needs a min_score/);
    p.delivery.digest.min_score = 60;
    expect(issues(p)).toEqual([]);
  });
});
