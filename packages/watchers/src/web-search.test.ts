import { describe, it, expect } from "vitest";
import { canonicalUrl, pickQueries, parseHitDate, postAuthor, hitsToItems, makeWebSearch, type SearchHit } from "./web-search.js";
import { isMappingAllowed } from "./policy.js";

const now = new Date("2026-11-14T06:00:00Z");

describe("web search source", () => {
  it("rotates queries by day and stops at the daily budget", () => {
    const qs = ["a", "b", "c", "d", "e"];
    expect(pickQueries(qs, 2, 0, 1, now)).toHaveLength(1);
    expect(pickQueries(qs, 2, 2, 1, now)).toEqual([]);
    const today = [...pickQueries(qs, 2, 0, 1, now), ...pickQueries(qs, 2, 1, 1, now)];
    const tomorrow = [...pickQueries(qs, 2, 0, 2, new Date(now.getTime() + 86_400_000))];
    expect(new Set(today).size).toBe(2);
    expect(tomorrow).not.toEqual(today);
    // more budget than queries: each query once a day
    expect(pickQueries(["a", "b"], 8, 0, 10, now).sort()).toEqual(["a", "b"]);
    expect(pickQueries(["a", "b"], 8, 2, 1, now)).toEqual([]);
  });
  it("parses relative and absolute result dates", () => {
    expect(parseHitDate("3 days ago", now)!.getTime()).toBe(now.getTime() - 3 * 86_400_000);
    expect(parseHitDate("1 week ago", now)!.getTime()).toBe(now.getTime() - 7 * 86_400_000);
    expect(parseHitDate("Nov 10, 2026", now)!.getFullYear()).toBe(2026);
    expect(parseHitDate(undefined, now)).toBeNull();
    expect(parseHitDate("yesterday-ish", now)).toBeNull();
  });
  it("reads the author from LinkedIn and X post URLs only", () => {
    expect(postAuthor("https://www.linkedin.com/posts/asha-verma-123_hiring-hubspot-activity-7262-abcd")).toEqual({ platform: "linkedin", handle: "asha-verma-123" });
    expect(postAuthor("https://in.linkedin.com/posts/asha-verma_x-activity-1")).toEqual({ platform: "linkedin", handle: "asha-verma" });
    expect(postAuthor("https://x.com/acmefounder/status/1856")).toEqual({ platform: "x", handle: "acmefounder" });
    expect(postAuthor("https://www.linkedin.com/company/acme")).toBeNull();
    expect(postAuthor("https://example.com/blog")).toBeNull();
  });
  it("turns hits into items: title + snippet, stale dated results dropped, ids without tracking params", () => {
    const hits: SearchHit[] = [
      { title: "Looking for a HubSpot freelancer", link: "https://www.linkedin.com/posts/asha-verma_x-activity-1?utm_source=share", snippet: "We need someone to set up our CRM.", date: "2 days ago" },
      { title: "Old post", link: "https://www.linkedin.com/posts/b_x-activity-2", snippet: "need help", date: "2 months ago" },
      { title: "", link: "https://example.com/a", snippet: "" },
    ];
    const items = hitsToItems(hits, "q", now, 14);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceId: "web_search", externalId: "linkedin.com/posts/asha-verma_x-activity-1", author: "asha-verma", meta: { platform: "linkedin", query: "q" } });
    expect(items[0]!.text).toContain("set up our CRM");
  });
  it("one URL per post across LinkedIn country hosts, twitter.com and tracking params", () => {
    const li = "https://www.linkedin.com/posts/asha-verma_x-activity-1";
    expect(canonicalUrl("https://in.linkedin.com/posts/asha-verma_x-activity-1/?utm_source=share#c")).toBe(li);
    expect(canonicalUrl("https://linkedin.com/posts/asha-verma_x-activity-1")).toBe(li);
    expect(canonicalUrl("https://twitter.com/acmefounder/status/1856?s=20")).toBe("https://x.com/acmefounder/status/1856");
    expect(canonicalUrl("https://mobile.twitter.com/acmefounder/status/1856")).toBe("https://x.com/acmefounder/status/1856");
    const items = hitsToItems([
      { title: "t", link: "https://in.linkedin.com/posts/asha-verma_x-activity-1?trk=a", snippet: "s" },
    ], "q", now, 14);
    expect(items[0]).toMatchObject({ url: li, externalId: "linkedin.com/posts/asha-verma_x-activity-1", author: "asha-verma" });
  });
  it("counts each search against the budget before making it", async () => {
    let used = 0;
    const calls: string[] = [];
    const w = makeWebSearch({
      queries: ["a", "b", "c"], perDay: 2, perTick: 5, timeRange: "w", country: "in", maxAgeDays: 14, now: () => now,
      budget: { used: async () => used, add: async (n) => { used += n; } },
      search: async (q) => { calls.push(q); return []; },
    });
    await w.fetch(now);
    await w.fetch(now);
    expect(calls).toHaveLength(2);
    expect(used).toBe(2);
  });
  it("authors are never mapped beyond the post itself", () => {
    expect(isMappingAllowed("web_search", "explicit")).toBe(true);
    expect(isMappingAllowed("web_search", "profile")).toBe(false);
  });
});
