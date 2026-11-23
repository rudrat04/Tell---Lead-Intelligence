import * as cheerio from "cheerio";
import { robotsAllows } from "./robots.js";
import { userAgent } from "./identity.js";

/**
 * The text of one news article, so an event can be fact-checked against what the article says rather than its
 * headline (robots.txt respected; outlets whose terms forbid automated reading are never fetched, see policy.ts).
 * Text only, never stored: the check keeps the verified quotes.
 */

/** outlets we may not read automatically (terms / robots, checked Nov 2026; policy.ts) */
const BLOCKED_HOSTS = /(^|\.)(inc42\.com|entrackr\.com|yourstory\.com|linkedin\.com|x\.com|twitter\.com|facebook\.com)$/i;
/** a structured record (an API or data portal), not an article: its stored quote is the evidence */
export const isRecordUrl = (url: string) => /^https?:\/\/(api\.|data\.)|\/api\/|\/resource\/|\.json(\?|$)|\/v\d+\/|usaspending\.gov|accessdata\.fda\.gov|clinicaltrials\.gov|npiregistry|sam\.gov/i.test(url);
const MAX_CHARS = 8000;

/** The article's readable text (pure; exported for tests): the article / main element's paragraphs, else every
 *  paragraph on the page; scripts, navigation, asides and footers go. */
export function articleText(html: string): string {
  const $ = cheerio.load(html.replace(/</g, " <"));
  $("script, style, noscript, svg, iframe, nav, header, footer, aside, form, figure figcaption, .related, .advertisement, .ad, [aria-hidden=true]").remove();
  const root = $("article").first().length ? $("article").first() : $("main").first().length ? $("main").first() : $("body");
  const paras = root.find("p, h1, h2, li").toArray().map((p) => $(p).text().replace(/\s+/g, " ").trim()).filter((t) => t.length >= 30);
  const text = (paras.length ? paras.join("\n") : root.text()).replace(/[ \t]+/g, " ").trim();
  return text.slice(0, MAX_CHARS);
}

/** Read an article. Null when it's a record URL, a blocked outlet, disallowed by robots.txt, unreachable or empty. */
export async function readArticle(url: string, timeoutMs = 15_000): Promise<{ url: string; text: string } | null> {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || BLOCKED_HOSTS.test(u.hostname) || isRecordUrl(url)) return null;
  if (!(await robotsAllows(u.toString()))) return null;
  try {
    const res = await fetch(u, { headers: { "user-agent": userAgent(), accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !/html/i.test(res.headers.get("content-type") ?? "html")) return null;
    const text = articleText((await res.text()).slice(0, 3_000_000));
    return text.length >= 200 ? { url: res.url, text } : null;
  } catch {
    return null;
  }
}
