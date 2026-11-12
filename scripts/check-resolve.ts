/**
 * Manual check: run entity resolution on real HN comments (live network, no Haiku, no DB writes).
 * Usage: pnpm exec tsx scripts/check-resolve.ts [hnItemId ...]
 * With no ids, samples a few comments from the latest "Who is hiring" thread.
 * Prints domains to your terminal only; never run this in CI (public logs).
 */
import * as cheerio from "cheerio";
import { resolve } from "node:path";
import type { RawItem } from "@tell/watchers";
import { resolveItem, loadDomainLists } from "@tell/people";
import { liveNet } from "@tell/pipeline";

type HnItem = { id: number; by?: string; text?: string; kids?: number[]; title?: string; time: number };
const get = async (id: number) => (await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json()) as HnItem;

let ids = process.argv.slice(2).map(Number);
if (ids.length === 0) {
  const s = (await (await fetch("https://hn.algolia.com/api/v1/search_by_date?query=%22Who%20is%20hiring%22&tags=story,author_whoishiring&hitsPerPage=1")).json()) as { hits: { objectID: string; title: string }[] };
  const story = await get(Number(s.hits[0]!.objectID));
  console.log(`thread: ${story.title}`);
  ids = (story.kids ?? []).slice(0, 8);
}

const lists = loadDomainLists(resolve(process.cwd(), "config/domains.yaml"));
for (const id of ids) {
  const it = await get(id);
  if (!it?.text) continue;
  const $ = cheerio.load(it.text);
  const hrefs = $("a[href]").map((_, a) => $(a).attr("href")).get().join(" ");
  const text = `${$.root().text()} ${hrefs}`;
  const firstLine = text.split(/\n|<p>/)[0]!.slice(0, 90);
  const companyName = firstLine.split("|")[0]!.trim() || null;
  const item: RawItem = { sourceId: "hn", externalId: String(id), url: `https://news.ycombinator.com/item?id=${id}`, text, author: it.by, postedAt: new Date(it.time * 1000), meta: {} };
  const res = await resolveItem(item, {
    author_role: "founder", ask_type: "hire", problem_category: "other", company_identifiable: true, company_name: companyName,
    urgency_or_budget_hint: false, self_promotion: false, strength: 4, evidence_quote: firstLine,
  }, lists, liveNet);
  const out = res.kind === "account" ? `ACCOUNT ${res.domain} (${res.confidence}, ${res.method})`
    : res.kind === "person" ? `PERSON ${res.platform}/${res.handle}${res.hint ? ` hint=${res.hint.domain}` : ""} (${res.reason})`
    : `UNRESOLVED (${res.reason})`;
  console.log(`${id} | ${firstLine}\n    -> ${out}`);
}
