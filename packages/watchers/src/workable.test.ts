import { describe, it, expect } from "vitest";
import { workablePostings, subdomainCandidates } from "./workable.js";
import { findBoardLinks } from "./board-links.js";

describe("workable", () => {
  it("normalises widget jobs with locations and country codes", () => {
    const [p] = workablePostings("tanmark", [{ shortcode: "AB12", title: " Account Executive ", employment_type: "Full-time", published_on: "2026-10-15",
      locations: [{ city: "Pune", country: "India", countryCode: "IN" }, { city: "Dubai", country: "UAE", countryCode: "AE", hidden: true }] }]);
    expect(p).toMatchObject({ externalId: "AB12", title: "Account Executive", location: "Pune, India", countryCodes: ["IN"], url: "https://apply.workable.com/tanmark/j/AB12/" });
    expect(p!.postedAt!.toISOString()).toBe("2026-10-15T00:00:00.000Z");
  });
  it("tries own-site slugs first, then forms of the name and domain", () => {
    expect(subdomainCandidates(["tanmark-hq"], "Tanmark Health", "tanmark.test")).toEqual(["tanmark-hq", "tanmark", "tanmarkhealth", "tanmark-health", "tanmark-1"]);
  });
  it("finds board links but not single-job links or the API", () => {
    const html = `<a href="https://apply.workable.com/tanmark/">Careers</a> <a href="https://apply.workable.com/j/E47E4A2E42">One job</a>
      <script src="https://apply.workable.com/api/v1/widget/accounts/x"></script> <a href="https://orrin.workable.com">Jobs</a> <a href="https://jobs.workable.com/view/abc">x</a>`;
    expect(findBoardLinks(html).filter((b) => b.ats === "workable").map((b) => b.slug).sort()).toEqual(["orrin", "tanmark"]);
  });
});
