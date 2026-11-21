import * as cheerio from "cheerio";
import { fetchHomepage, fetchSitePage } from "./site.js";
import { robotsAllows } from "./robots.js";

/**
 * A company's own words about what it sells: its homepage plus a few pages whose links look like products, services,
 * capabilities, markets or exports (robots.txt respected, same site only). Used to prove a fit before a lead goes out
 * ("does this API maker make apixaban?", "does this broker ship to the UAE?"). Text only, never stored as pages.
 */

export interface SitePage { url: string; text: string }

const PAGE_HINT = /product|service|portfolio|capabilit|solution|offering|range|catalog|catalogue|molecule|api\b|ingredient|export|market|industr|sector|what-we-do|about|countr|network|destination|equipment|machine|facilit/i;
const MAX_CHARS = 6000;

/** Visible text and same-site links of a page (pure; exported for tests). Scripts, styles, nav chrome and cookie
 *  banners go; whitespace is folded. */
export function pageTextAndLinks(html: string, baseUrl: string): { text: string; links: { url: string; label: string }[] } {
  // a space before every tag: text in neighbouring elements ("<h1>Datum</h1><p>We make") must not glue into one word
  const $ = cheerio.load(html.replace(/</g, " <"));
  $("script, style, noscript, svg, iframe, [aria-hidden=true], .cookie, #cookie, .cookies").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const base = new URL(baseUrl);
  const links: { url: string; label: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    try {
      const u = new URL($(a).attr("href")!, base);
      u.hash = "";
      if (u.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "") || seen.has(u.toString()) || /\.(pdf|jpe?g|png|zip|docx?)$/i.test(u.pathname)) return;
      seen.add(u.toString());
      links.push({ url: u.toString(), label: $(a).text().replace(/\s+/g, " ").trim().slice(0, 80) });
    } catch { /* not a URL */ }
  });
  return { text, links };
}

/** Which links to read after the homepage (pure; exported for tests): the event's own words first ("apixaban",
 *  "UAE"), then product / service / market pages; at most `n`. */
export function pickPages(links: { url: string; label: string }[], words: string[], n = 3): string[] {
  const w = words.map((x) => x.toLowerCase()).filter((x) => x.length >= 3);
  const score = (l: { url: string; label: string }) => {
    const t = `${l.url} ${l.label}`.toLowerCase();
    return (w.some((x) => t.includes(x)) ? 2 : 0) + (PAGE_HINT.test(t) ? 1 : 0);
  };
  return links.map((l) => ({ l, s: score(l) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.l.url);
}

/** Firecrawl's rendered markdown of one page (sites built in JavaScript show no text to a plain fetch). */
async function firecrawl(url: string, key: string): Promise<string | null> {
  if (!(await robotsAllows(url))) return null;
  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }), signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { data?: { markdown?: string } };
    return j.data?.markdown?.replace(/\s+/g, " ").trim() || null;
  } catch { return null; }
}

/**
 * Homepage + up to `pages` more of the company's site. `rendered` = allowed to use Firecrawl (one credit) when the
 * homepage shows almost no text. Empty = nothing readable (then nothing can be proven).
 */
export async function readSite(domain: string, words: string[], opts: { pages?: number; rendered?: boolean } = {}): Promise<{ pages: SitePage[]; usedFirecrawl: boolean }> {
  const out: SitePage[] = [];
  let usedFirecrawl = false;
  const home = await fetchHomepage(domain);
  if (home) {
    const { text, links } = pageTextAndLinks(home.html, home.url);
    if (text.length >= 200) out.push({ url: home.url, text: text.slice(0, MAX_CHARS) });
    for (const u of pickPages(links, words, opts.pages ?? 3)) {
      const p = await fetchSitePage(u, domain);
      if (!p) continue;
      const t = pageTextAndLinks(p.html, p.url).text;
      if (t.length >= 200) out.push({ url: p.url, text: t.slice(0, MAX_CHARS) });
    }
  }
  const key = process.env.FIRECRAWL_API_KEY;
  if (!out.length && opts.rendered && key) {
    const md = await firecrawl(`https://${domain}/`, key);
    usedFirecrawl = true;
    if (md && md.length >= 200) out.push({ url: `https://${domain}/`, text: md.slice(0, MAX_CHARS) });
  }
  return { pages: out, usedFirecrawl };
}
