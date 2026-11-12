import { describe, it, expect } from "vitest";
import { parseYcJobsPage, relativeAgeToDate } from "./yc.js";
import { findBoardLinks } from "./board-links.js";

const now = new Date(Date.UTC(2026, 10, 12));

/** Shape of a real YC company jobs page (Nov 2026): JSON in an HTML-escaped data-page attribute. */
const page = (jobs: unknown[]) =>
  `<div id="app" data-page="${JSON.stringify({ component: "WaasShowJobsPage", props: { jobPostings: jobs } }).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></div>`;

describe("YC jobs page", () => {
  it("parses postings with type and approximate posted date", () => {
    const jobs = parseYcJobsPage(page([
      { id: 92756, title: "Product Marketing Manager", url: "/companies/acme/jobs/06T3lN5-product-marketing-manager", type: "Full-time", role: "marketing", createdAt: "7 months" },
      { id: 1, title: "RevOps & Systems (Contract)", url: "/companies/acme/jobs/x", type: "Contract", createdAt: "3 days" },
    ]), now);
    expect(jobs[0]).toMatchObject({ externalId: "92756", url: "https://www.ycombinator.com/companies/acme/jobs/06T3lN5-product-marketing-manager", employmentType: "Full-time" });
    expect(Math.round((now.getTime() - jobs[0]!.postedAt!.getTime()) / 86_400_000)).toBe(210);
    expect(jobs[1]!.title).toBe("RevOps & Systems (Contract)");
  });
  it("throws on an unexpected page shape (so a broken page never closes every job)", () => {
    expect(() => parseYcJobsPage("<html>nothing here</html>", now)).toThrow();
  });
  it("relative ages", () => {
    expect(relativeAgeToDate("about 1 month", now)?.getTime()).toBe(now.getTime() - 30 * 86_400_000);
    expect(relativeAgeToDate("a year", now)?.getTime()).toBe(now.getTime() - 365 * 86_400_000);
    expect(relativeAgeToDate("", now)).toBeUndefined();
  });
});

describe("board links on a company's own site", () => {
  it("finds Ashby, Lever and Greenhouse boards incl. embeds", () => {
    const html = `<a href="https://jobs.ashbyhq.com/acme">Jobs</a> <a href="https://jobs.lever.co/acme-inc/123">x</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmehq"></script> https://job-boards.greenhouse.io/acme2`;
    expect(findBoardLinks(html)).toEqual([
      { ats: "greenhouse", slug: "acme2" },
      { ats: "greenhouse", slug: "acmehq" },
      { ats: "lever", slug: "acme-inc" },
      { ats: "ashby", slug: "acme" },
    ]);
  });
});
