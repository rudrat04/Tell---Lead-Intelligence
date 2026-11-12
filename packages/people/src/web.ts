import * as cheerio from "cheerio";
import { registrableDomain } from "./domains.js";

const UA = "TellLeadIntelligence/0.1 (research bot; respects robots.txt)";

const PARKED = /(domain (is )?for sale|buy this domain|this domain (may be|is) for sale|parked (free|domain)|domain parking|sedo|dan\.com|afternic|hugedomains)/i;

export interface HomepageCheck {
  ok: boolean;
  /** registrable domain after redirects */
  finalDomain?: string;
  title?: string;
  reason?: string;
}

/**
 * Follow redirects on the homepage. Unresolved if it lands on another registrable domain
 * (unless that domain is on the same "brand", e.g. acme.io -> acme.com) or on a parking page.
 */
export async function checkHomepage(domain: string, timeoutMs = 10_000): Promise<HomepageCheck> {
  try {
    const res = await fetch(`https://${domain}/`, { redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    const finalDomain = registrableDomain(res.url) ?? domain;
    const html = res.ok ? (await res.text()).slice(0, 200_000) : "";
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim().slice(0, 200);
    if (PARKED.test(title) || PARKED.test($("body").text().slice(0, 5000))) return { ok: false, finalDomain, title, reason: "parked" };
    if (finalDomain !== domain) {
      const sameBrand = finalDomain.split(".")[0] === domain.split(".")[0];
      if (!sameBrand) return { ok: false, finalDomain, title, reason: "redirects to another domain" };
    }
    if (!res.ok && res.status !== 403 && res.status !== 401) return { ok: false, finalDomain, title, reason: `HTTP ${res.status}` };
    return { ok: true, finalDomain, title };
  } catch (e) {
    return { ok: false, reason: `unreachable: ${String(e).slice(0, 80)}` };
  }
}

/** Expand a shortened link to its destination URL (HEAD, then GET if HEAD is refused). */
export async function expandShortUrl(url: string, timeoutMs = 8_000): Promise<string | null> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, { method, redirect: "follow", headers: { "user-agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
      if (res.url && res.url !== url) return res.url;
    } catch { /* try next */ }
  }
  return null;
}

/** HN user profile "about" text (official Firebase API), HTML stripped. */
export async function fetchHnAbout(user: string, timeoutMs = 8_000): Promise<string | null> {
  const res = await fetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(user)}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const j = (await res.json()) as { about?: string } | null;
  if (!j?.about) return null;
  const $ = cheerio.load(j.about);
  const hrefs = $("a[href]").map((_, a) => $(a).attr("href")).get().join(" ");
  return `${$.root().text()} ${hrefs}`; // link text can be truncated, so keep the hrefs too
}
