import { request } from "undici";
import { RawItemSchema, type RawItem, type Watcher } from "./types.js";

const UA = "TellLeadIntelligence/0.1 (personal research script)";

export const REDDIT_SUBS = ["SaaS", "startups", "Entrepreneur", "RevOps", "sales", "marketing", "agency", "hubspot", "salesforce", "coldemail"];
export const FORHIRE_SUBS = ["forhire", "hiring", "freelance_forhire"];

export interface RedditPost {
  id: string;
  subreddit: string;
  title: string;
  selftext?: string;
  author: string;
  permalink: string;
  created_utc: number;
  link_flair_text?: string | null;
}

/** `[Hiring]` tag parsed in code before any LLM (plan section 5a). Strongest explicit-intent source. */
export function isHiringPost(p: Pick<RedditPost, "title" | "link_flair_text">): boolean {
  return /^\s*\[?\s*hiring\s*\]?/i.test(p.title) || /hiring/i.test(p.link_flair_text ?? "");
}

export function parsePosts(posts: RedditPost[], opts: { forhire: boolean }): RawItem[] {
  return posts
    .filter((p) => !opts.forhire || isHiringPost(p)) // in forhire subs drop [For Hire] posts (job seekers)
    .map((p) =>
      RawItemSchema.parse({
        sourceId: opts.forhire ? "forhire-subs" : "reddit",
        externalId: p.id,
        url: `https://www.reddit.com${p.permalink}`,
        title: p.title,
        text: `${p.title}\n\n${p.selftext ?? ""}`.trim(),
        author: p.author,
        postedAt: new Date(p.created_utc * 1000),
        meta: { subreddit: p.subreddit, hiringTag: opts.forhire ? true : isHiringPost(p) },
      }),
    );
}

async function token(): Promise<string> {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret, REDDIT_USERNAME: u, REDDIT_PASSWORD: pw } = process.env;
  if (!id || !secret || !u || !pw) throw new Error("Reddit credentials missing (REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD)");
  const res = await request("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: { "user-agent": UA, authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: u, password: pw }).toString(),
  });
  const j = (await res.body.json()) as { access_token?: string };
  if (!j.access_token) throw new Error(`Reddit auth failed (${res.statusCode})`);
  return j.access_token;
}

async function listing(sub: string, tok: string): Promise<RedditPost[]> {
  const res = await request(`https://oauth.reddit.com/r/${sub}/new?limit=100&raw_json=1`, { headers: { "user-agent": UA, authorization: `bearer ${tok}` } });
  if (res.statusCode >= 400) throw new Error(`r/${sub} -> ${res.statusCode}`);
  const j = (await res.body.json()) as { data: { children: { data: RedditPost }[] } };
  return j.data.children.map((c) => c.data);
}

function make(id: string, subs: string[], forhire: boolean): Watcher {
  return {
    id,
    async fetch(since) {
      const tok = await token();
      const out: RawItem[] = [];
      for (const sub of subs) {
        const posts = (await listing(sub, tok)).filter((p) => p.created_utc * 1000 > since.getTime());
        out.push(...parsePosts(posts, { forhire }));
        await new Promise((r) => setTimeout(r, 1000)); // low volume, polite
      }
      return out;
    },
  };
}

export const reddit = make("reddit", REDDIT_SUBS, false);
export const forhireSubs = make("forhire-subs", FORHIRE_SUBS, true);
