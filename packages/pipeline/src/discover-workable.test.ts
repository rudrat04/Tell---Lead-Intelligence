import { describe, it, expect } from "vitest";
import { groupHits } from "./discover-workable.js";

const hit = (jobId: string, companyId: string, website: string | null) =>
  ({ jobId, title: "Sales Manager", url: "https://jobs.workable.com/view/x", countryName: "India", city: "Pune", companyId, companyName: "Tanmark", website });

describe("groupHits", () => {
  it("groups by Workable company, dedupes jobs across queries, keeps a website if any hit has one", () => {
    const g = groupHits([hit("j1", "c1", null), hit("j1", "c1", null), hit("j2", "c1", "https://tanmark.test/"), hit("j3", "c2", "https://orrin.test")]);
    expect(g.map((c) => [c.id, c.hits.length, c.website])).toEqual([["c1", 2, "https://tanmark.test/"], ["c2", 1, "https://orrin.test"]]);
  });
});
