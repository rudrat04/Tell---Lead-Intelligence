import { describe, it, expect } from "vitest";
import { companyFromHeadline, companiesFromNews, isFundingHeadline, newsDate, companyKey } from "./funding-news.js";

describe("funding headlines", () => {
  it("takes the company name after descriptors, before the funding verb", () => {
    expect(companyFromHeadline("Bengaluru-based fintech startup Paylane raises $3 million in seed round")).toBe("Paylane");
    expect(companyFromHeadline("From rafting to trekking: Trailkit raises Rs 5 crore")).toBe("Trailkit");
    expect(companyFromHeadline("Exclusive: Fictiva Labs secures $10.3 Mn in Series A Funding")).toBe("Fictiva Labs");
    expect(companyFromHeadline("Specialty chemicals startup chemX raises $4M")).toBe("chemX");
    expect(companyFromHeadline("Ex-banker's climate startup Gridwise bags pre-seed funding")).toBe("Gridwise");
  });
  it("returns null without a plausible name", () => {
    expect(companyFromHeadline("Indian startups raised $200M this week")).toBeNull();
    expect(companyFromHeadline("Funding news roundup for November")).toBeNull();
    expect(companyFromHeadline("India raises interest rates")).toBeNull();
  });
  it("keeps rounds, drops roundups and investors' own funds", () => {
    const kw = ["rais", "funding", "seed", "series [a-d]"], ex = ["roundup", "weekly", "fund", "first close"];
    expect(isFundingHeadline("Paylane raises seed funding", kw, ex)).toBe(true);
    expect(isFundingHeadline("Weekly funding roundup: 20 startups", kw, ex)).toBe(false);
    expect(isFundingHeadline("Northwind Ventures announces first close of $50M fund", kw, ex)).toBe(false);
  });
  it("one entry per company, newest story first", () => {
    const now = new Date("2026-11-19T00:00:00Z");
    const list = companiesFromNews([
      { title: "Paylane raises $3M", url: "https://news.test/a", postedAt: new Date(now.getTime() - 3 * 86_400_000) },
      { title: "PayLane raises $3 million seed", url: "https://news.test/b", postedAt: new Date(now.getTime() - 86_400_000) },
    ]);
    expect(list).toHaveLength(1);
    expect(list[0]!.url).toBe("https://news.test/b");
    expect(companyKey("Pay-Lane")).toBe(companyKey("PAYLANE"));
  });
  it("reads relative and absolute dates; future dates are no date", () => {
    const now = new Date("2026-11-19T12:00:00Z");
    expect(newsDate("3 days ago", now)!.toISOString()).toBe("2026-11-16T12:00:00.000Z");
    expect(newsDate("Nov 10, 2026", now)).not.toBeNull();
    expect(newsDate("Dec 10, 2026", now)).toBeNull();
    expect(newsDate(undefined, now)).toBeNull();
  });
});
