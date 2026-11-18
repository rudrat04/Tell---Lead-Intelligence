import { describe, it, expect } from "vitest";
import { gapVerdict, gapQuote, rolePattern, interleave } from "./gaps.js";

const groups = {
  GTM: ["GTM Engineer", "Head of GTM", "Revenue Operations"],
  "Founder's Office": ["Founder's Office", "Chief of Staff"],
  "Product Marketing": ["Product Marketing"],
};

describe("need check (role gaps)", () => {
  it("matches titles loosely: apostrophes, dashes, case", () => {
    const rx = rolePattern(["Founder's Office"]);
    for (const t of ["Founders Office", "founder’s office", "Founder's-Office Associate"]) expect(rx.test(t)).toBe(true);
    expect(rolePattern(["GTM Engineer"]).test("Senior GTM-Engineer at Fictiva")).toBe(true);
    expect(rolePattern(["PMM"]).test("PMMs")).toBe(false); // whole words only
  });
  it("lists the groups nobody holds, and who holds the others", () => {
    const v = gapVerdict(groups, [
      { name: "Asha Verma", role: "Chief of Staff at Fictiva" },
      { name: "Ravi Kulkarni", role: "Co-Founder at Fictiva" },
    ]);
    expect(v.missing).toEqual(["GTM", "Product Marketing"]);
    expect(v.has).toEqual([{ group: "Founder's Office", name: "Asha Verma", role: "Chief of Staff at Fictiva" }]);
    expect(gapQuote(v)).toBe("Missing: GTM, Product Marketing · has Founder's Office: Asha Verma (Chief of Staff at Fictiva)");
  });
  it("a founder fills no seat; every seat filled = nothing missing", () => {
    expect(gapVerdict(groups, [{ name: "Ravi Kulkarni", role: "Founder & CEO" }]).missing).toHaveLength(3);
    expect(gapVerdict(groups, [
      { name: "A", role: "GTM Engineer" }, { name: "B", role: "Chief of Staff" }, { name: "C", role: "Product Marketing Manager" },
    ]).missing).toEqual([]);
  });
  it("interleaves groups so a cut-short query covers each group's main title", () => {
    expect(interleave([["a1", "a2"], ["b1"], ["c1", "c2"]])).toEqual(["a1", "b1", "c1", "a2", "c2"]);
  });
});
