import { describe, it, expect } from "vitest";
import { isHiringPost, parsePosts, type RedditPost } from "./reddit.js";

const base: RedditPost = { id: "a1", subreddit: "forhire", title: "", author: "u", permalink: "/r/forhire/comments/a1/x/", created_utc: 1_700_000_000 };

describe("reddit", () => {
  it("detects [Hiring] tags", () => {
    expect(isHiringPost({ title: "[Hiring] HubSpot + outbound freelancer" })).toBe(true);
    expect(isHiringPost({ title: "[For Hire] RevOps consultant" })).toBe(false);
    expect(isHiringPost({ title: "Need help", link_flair_text: "Hiring" })).toBe(true);
  });
  it("drops For Hire posts in forhire subs", () => {
    const items = parsePosts([{ ...base, title: "[Hiring] CRM setup" }, { ...base, id: "a2", title: "[For Hire] me" }], { forhire: true });
    expect(items).toHaveLength(1);
    expect(items[0]!.sourceId).toBe("forhire-subs");
  });
  it("keeps all posts in general subs, flags hiring tag", () => {
    const items = parsePosts([{ ...base, subreddit: "SaaS", title: "How do I set up HubSpot?" }], { forhire: false });
    expect(items[0]!.meta.hiringTag).toBe(false);
  });
});
