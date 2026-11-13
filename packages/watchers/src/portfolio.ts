import { robotsAllows } from "./robots.js";
import { politeGet } from "./http.js";

/**
 * VC / accelerator portfolio pages (India coverage). Each company page names the company's own website, so the
 * domain is stated by the source (never guessed from the name). Checked Nov 2026: Surge's and Peak XV's robots.txt
 * allow all crawlers ("visibility is the point"); no terms page bans automated access. Robots is checked per page.
 * Region never comes from the investor: it comes from the company's job locations.
 */

export interface PortfolioSource { id: string; index: string; company_path: string; max_pages?: number; website_labels?: string[] }
export interface PortfolioCompany { slug: string; url: string; name: string | null; website: string | null }

/** Company page URLs on an index page, plus the next index page (Webflow-style `?xxx_page=N` links). Exported for tests. */
export function parseIndex(html: string, base: string, companyPath: string): { companies: string[]; pages: string[] } {
  const origin = new URL(base).origin;
  const esc = companyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const companies = new Set<string>();
  for (const m of html.matchAll(new RegExp(`href="((?:${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})?${esc}[a-z0-9-]+)/?"`, "gi"))) {
    companies.add(new URL(m[1]!, origin).toString().replace(/\/$/, ""));
  }
  // every paginated list on the page (Webflow-style ?xxx_page=N); the caller visits each page once
  const pages = new Set<string>();
  for (const m of html.matchAll(/href="(\?[a-z0-9_]+_page=\d+)"/gi)) pages.add(new URL(m[1]!.replace(/&amp;/g, "&"), new URL(base).origin + new URL(base).pathname).toString());
  return { companies: [...companies], pages: [...pages] };
}

/** The link the page labels "Website" (or "Visit website"), and the page title as the company name. Exported for tests. */
export function parseCompanyPage(html: string, labels: string[] = ["website", "visit website", "visit site"]): { name: string | null; website: string | null } {
  const name = html.match(/<h1[^>]*>([^<]{2,80})<\/h1>/i)?.[1]?.trim() ?? html.match(/<title>([^<|–-]{2,80})/i)?.[1]?.trim() ?? null;
  // the first external link after a "Website" label, within a short window (no guessing from other links)
  const alt = labels.map((l) => l.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
  const label = html.search(new RegExp(`>\\s*(?:${alt})\\s*<`, "i"));
  let website: string | null = null;
  if (label >= 0) {
    const m = html.slice(label, label + 1500).match(/href="(https?:\/\/[^"]+)"/i);
    if (m) website = m[1]!;
  }
  return { name: name ? name.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'") : null, website };
}

/** Every company page on a portfolio (follows next-page links up to max_pages). */
export async function listPortfolio(src: PortfolioSource): Promise<string[]> {
  const out = new Set<string>();
  const queue = [src.index], seen = new Set(queue);
  for (let i = 0; queue.length && i < (src.max_pages ?? 20); i++) {
    const url = queue.shift()!;
    if (!(await robotsAllows(url))) continue;
    const page = parseIndex(await politeGet(url, 1500), url, src.company_path);
    page.companies.forEach((c) => out.add(c));
    for (const p of page.pages) if (!seen.has(p)) { seen.add(p); queue.push(p); }
  }
  return [...out];
}

export async function fetchPortfolioCompany(url: string, labels?: string[]): Promise<PortfolioCompany | null> {
  if (!(await robotsAllows(url))) return null;
  const p = parseCompanyPage(await politeGet(url, 1500), labels);
  return { slug: url.split("/").filter(Boolean).pop()!, url, ...p };
}
