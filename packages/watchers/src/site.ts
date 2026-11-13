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
  /** where the page's lead forms send data when it isn't a CRM: "formspree", "mailto", "typeform"... (empty = no such form) */
  leakyForms: string[];
  /** a page form exists at all (any <form> with an input, or a form-builder embed) */
  hasForm: boolean;
  /** shows a HubSpot / Salesforce / other partner badge: the company sells GTM services itself */
  partnerBadge: boolean;
  /** "marketing by Acme", "growth partner: Acme": an outside GTM agency is credited */
  agencyCredit: string | null;
}

const FORM_SINKS: [string, RegExp][] = [
  ["formspree", /formspree\.io/i], ["getform", /getform\.io/i], ["formsubmit", /formsubmit\.co/i], ["basin", /usebasin\.com/i],
  ["google forms", /docs\.google\.com\/forms|forms\.gle\//i], ["typeform", /typeform\.com|embed\.typeform/i], ["tally", /tally\.so/i],
  ["jotform", /jotform\.(com|me)/i], ["web3forms", /web3forms\.com/i], ["netlify forms", /data-netlify="true"|netlify-honeypot/i],
];
const PARTNER = /\b(hubspot (solutions|platinum|gold|diamond|elite) partner|salesforce (consulting|crm) partner|pipedrive (certified )?partner|zoho (authori[sz]ed )?partner|clay (expert|partner)|certified (hubspot|salesforce) (agency|partner))\b/i;
const AGENCY_CREDIT = /\b(?:[Mm]arketing|[Gg]rowth|[Dd]emand [Gg]en(?:eration)?|SEO|[Pp]erformance [Mm]arketing|RevOps|GTM) (?:[Bb]y|[Pp]artner:?)\s+([A-Z][\w&.' -]{1,40})/;

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
  const formsHtml = [...$("form").map((_, el) => `${$(el).attr("action") ?? ""} ${$.html(el).slice(0, 600)}`).get(), ...$("iframe[src], script[src]").map((_, el) => $(el).attr("src") ?? "").get()].join("\n");
  const formActions = $("form").map((_, el) => ($(el).attr("action") ?? "").trim()).get();
  const leaky = FORM_SINKS.filter(([, r]) => r.test(formsHtml)).map(([k]) => k);
  if (formActions.some((a) => /^mailto:/i.test(a))) leaky.push("mailto");
  const hasForm = $("form input, form textarea").length > 0 || leaky.length > 0;
  const bodyText = $("body").text().replace(/\s+/g, " ");
  return {
    title: $("title").first().text().trim().slice(0, 150),
    ctas,
    salesLed: ctas.some((t) => SALES_LED.test(t)),
    selfServe: ctas.some((t) => SELF_SERVE.test(t)),
    pricing,
    tools: found.sort(),
    leakyForms: [...new Set(leaky)],
    hasForm,
    partnerBadge: PARTNER.test(bodyText) || $("img[alt]").get().some((el) => PARTNER.test($(el).attr("alt") ?? "")),
    agencyCredit: bodyText.slice(-3000).match(AGENCY_CREDIT)?.[1]?.trim() ?? null,
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
