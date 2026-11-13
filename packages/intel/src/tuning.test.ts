import { describe, it, expect } from "vitest";
import { proposeLrs, pairwiseAgreement, leadWeight, type LabelledLead } from "./tuning.js";

const cur = { core_role_open: { lr: 4 }, stack_sprawl: { lr: 2.5 }, funding_raise: { lr: 2.5 } };
const lead = (types: string[], label: "good" | "bad" | null, outcome: string | null = null): LabelledLead => ({ types, label, outcome });

describe("self-tuning proposals", () => {
  it("no labels, no change", () => {
    expect(proposeLrs(cur, [])).toEqual([]);
  });
  it("a handful of labels barely moves anything (shrinkage + minimum leads)", () => {
    expect(proposeLrs(cur, [lead(["stack_sprawl"], "bad"), lead(["stack_sprawl"], "bad"), lead(["core_role_open"], "good")])).toEqual([]);
  });
  it("lowers a type that keeps producing bad leads and raises one that produces good, capped per week", () => {
    const leads = [
      ...Array.from({ length: 10 }, () => lead(["stack_sprawl"], "bad")),
      ...Array.from({ length: 10 }, () => lead(["core_role_open"], "good")),
      ...Array.from({ length: 5 }, () => lead(["funding_raise"], "good")), ...Array.from({ length: 5 }, () => lead(["funding_raise"], "bad")),
    ];
    const p = Object.fromEntries(proposeLrs(cur, leads).map((x) => [x.type, x]));
    expect(p.stack_sprawl!.after).toBeLessThan(2.5);
    expect(p.stack_sprawl!.after).toBeGreaterThanOrEqual(2.5 * 0.75);
    expect(p.core_role_open!.after).toBeGreaterThan(4);
    expect(p.core_role_open!.after).toBeLessThanOrEqual(4 * 1.25);
    expect(p.funding_raise).toBeUndefined(); // as good as average: no change
  });
  it("replies and meetings weigh more than a Good tap", () => {
    expect(leadWeight(lead([], null, "meeting")).good).toBeGreaterThan(leadWeight(lead([], "good")).good);
    expect(leadWeight(lead([], null, "no reply"))).toEqual({ good: 0, bad: 0.5 });
  });
  it("pairwise agreement: 1 when every good outranks every bad, 0.5 for chance", () => {
    expect(pairwiseAgreement([{ good: true, priority: 0.9 }, { good: false, priority: 0.1 }])).toEqual({ agreement: 1, pairs: 1 });
    expect(pairwiseAgreement([{ good: true, priority: 0.5 }, { good: false, priority: 0.5 }]).agreement).toBe(0.5);
  });
});
