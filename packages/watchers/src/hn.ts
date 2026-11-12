import { getJson } from "./http.js";
import { RawItemSchema, type RawItem, type Watcher } from "./types.js";
import * as cheerio from "cheerio";


interface AlgoliaHit {
  objectID: string;
  title?: string | null;
  story_text?: string | null;
  comment_text?: string | null;
  author: string;
  created_at: string;
}

const strip = (html?: string | null) => (html ? cheerio.load(html).text() : "");

/** HN via Algolia search (also serves as the fallback path per plan 5d). Queries come from the pack. */
export const makeHn = (queries: string[]): Watcher => ({
  id: "hn",
  async fetch(since) {
    const ts = Math.floor(since.getTime() / 1000);
    const out: RawItem[] = [];
    for (const q of queries) {
      const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=(story,comment)&numericFilters=created_at_i>${ts}&hitsPerPage=50`;
      const data = await getJson<{ hits: AlgoliaHit[] }>(url);
      for (const h of data.hits) {
        const text = strip(h.comment_text ?? h.story_text) || h.title || "";
        if (!text) continue;
        out.push(
          RawItemSchema.parse({
            sourceId: "hn",
            externalId: h.objectID,
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            title: h.title ?? undefined,
            text,
            author: h.author,
            postedAt: h.created_at,
          }),
        );
      }
    }
    return [...new Map(out.map((i) => [i.externalId, i])).values()];
  },
});
