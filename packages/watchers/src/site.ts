import * as cheerio from "cheerio";
import { robotsAllows } from "./robots.js";
import { userAgent } from "./identity.js";

/** Structured facts from a homepage (plan 5b: diff fields, not page hashes, so a copy tweak doesn't fire). */
export interface SiteFacts {
  title: string;
  /** short button/link texts that look like calls to action */
  ctas: string[];
  /** a "book a demo" / "contact sales" style call to action is present */
  salesLed: boolean;
  /** a "start free" / "sign up" style call to action is present */
  selfServe: boolean;
  /** a pricing page is linked */
  pricing: boolean;
  /** tool keys detected in scripts/links (filled by the caller's tool rules) */
  tools: string[];
}

const SALES_LED = /\b((book|schedule|request|get|see) (a |your |an? )?(free )?(demo|call|consultation)|contact sales|talk to (sales|an expert|our team|us)|speak (to|with) (sales|an expert))\b/i;
const SELF_SERVE = /\b((start|try) (it )?(for )?free|free trial|sign ?up( free)?|get started( free| for free)?|create (a |an )?(free )?account)\b/i;
const CTA_LIKE = new RegExp(`${SALES_LED.source}|${SELF_SERVE.source}|\\b(pricing|plans)\\b`, "i");

export interface ToolRule { key: string; site: RegExp[] }

/** Pure: extract facts from homepage HTML. */
export function extractSiteFacts(html: string, tools: ToolRule[]): SiteFacts {
  const $ = cheerio.load(html);
  const texts = $("a, button").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter((t) => t.length > 1 && t.length <= 40);
  const ctas = [...new Set(texts.filter((t) => CTA_LIKE.test(t)))].slice(0, 12);
  const hrefs = $("a[href]").map((_, el) => $(el).attr("href") ?? "").get();
  const pricing = hrefs.some((h) => /\/(pricing|plans)(\/|\?|#|$)/i.test(h)) || texts.some((t) => /^(pricing|plans( & pricing)?)$/i.test(t));
  // tools: script/link URLs plus the first part of each inline script (tag snippets)
  const assets = [
    ...$("script[src]").map((_, el) => $(el).attr("src") ?? "").get(),
    ...$("link[href]").map((_, el) => $(el).attr("href") ?? "").get(),
    ...$("iframe[src]").map((_, el) => $(el).attr("src") ?? "").get(),
    ...$("script:not([src])").map((_, el) => ($(el).html() ?? "").slice(0, 4000)).get(),
  ].join("\n");
  const found = tools.filter((t) => t.site.some((r) => r.test(assets))).map((t) => t.key);
  return {
    title: $("title").first().text().trim().slice(0, 150),
    ctas,
    salesLed: ctas.some((t) => SALES_LED.test(t)),
    selfServe: ctas.some((t) => SELF_SERVE.test(t)),
    pricing,
    tools: found.sort(),
  };
}

/** Fetch a company homepage (robots.txt respected). Null when blocked or unreachable. */
export async function fetchHomepage(domain: string, timeoutMs = 15_000): Promise<{ url: string; html: string } | null> {
  const url = `https://${domain}/`;
  if (!(await robotsAllows(url))) return null;
  try {
    const res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return { url: res.url, html: (await res.text()).slice(0, 2_000_000) };
  } catch {
    return null;
  }
}

/** TXT records (SPF includes, domain-verification tokens) via Cloudflare DNS-over-HTTPS. */
export async function fetchTxtRecords(domain: string, timeoutMs = 10_000): Promise<string[] | null> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    if (j.Status !== 0 && j.Status !== 3) return null; // 3 = NXDOMAIN (no records): an answer, not a failure
    return (j.Answer ?? []).filter((a) => a.type === 16).map((a) => a.data.replace(/"\s*"/g, "").replace(/^"|"$/g, ""));
  } catch {
    return null;
  }
}
