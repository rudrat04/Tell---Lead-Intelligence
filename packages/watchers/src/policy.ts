/**
 * Per-source terms-of-use policy, enforced in code.
 *
 * Reddit (Responsible Builder Policy): API access needs explicit approval, commercial use needs
 * written approval, and re-identifying users "including by matching data with off-platform
 * identifiers" is prohibited. So Reddit stays disabled until approved, and Reddit authors may only
 * be linked to a company the post itself names or links (never via profiles or other platforms).
 */

export type MappingConfidence = "explicit" | "profile" | "cross-platform" | "hint";

export interface SourcePolicy {
  enabled: boolean;
  /** which author-mapping methods (plan 8a) are allowed for authors from this source */
  allowedMappings: MappingConfidence[];
  note?: string;
}

const ALL: MappingConfidence[] = ["explicit", "profile", "cross-platform", "hint"];

export const SOURCE_POLICY: Record<string, SourcePolicy> = {
  reddit: { enabled: false, allowedMappings: ["explicit"], note: "Awaiting Reddit API approval (Responsible Builder Policy)" },
  "forhire-subs": { enabled: false, allowedMappings: ["explicit"], note: "Awaiting Reddit API approval (Responsible Builder Policy)" },
  hn: { enabled: true, allowedMappings: ALL },
  // Keka tenants: robots.txt allows only /careers (the portal's own JSON API sits under it). Freshteam: only /jobs.
  // Tenants are listed from Common Crawl's public URL index; each tenant's robots.txt is checked before use.
  keka: { enabled: true, allowedMappings: ["explicit"], note: "robots.txt: /careers only" },
  freshteam: { enabled: true, allowedMappings: ["explicit"], note: "robots.txt: /jobs only" },
  // Workable: robots.txt doesn't block the job-search or widget APIs (ai-input=yes); terms have no automated-access ban.
  workable: { enabled: true, allowedMappings: ["explicit"], note: "public job search + widget API" },
  // Portfolio pages: Surge / Peak XV robots.txt allow all crawlers; robots checked per page.
  portfolio: { enabled: true, allowedMappings: ["explicit"], note: "company page's own Website link only" },
  // Checked Nov 2026 and NOT used: Inc42 terms ban bots/monitoring; Entrackr terms ban automated collection without
  // written consent; YourStory robots.txt blocks AI and RSS bots; Zoho Recruit career sites are a JS app whose job
  // data sits behind paths robots.txt disallows.
  inc42: { enabled: false, allowedMappings: [], note: "terms: no bots without written approval" },
  entrackr: { enabled: false, allowedMappings: [], note: "terms: no automated collection without written consent" },
  yourstory: { enabled: false, allowedMappings: [], note: "robots.txt blocks AI/RSS bots" },
  zohorecruit: { enabled: false, allowedMappings: [], note: "JS app; job data behind robots-disallowed paths" },
  // Certificate Transparency: SSLMate Cert Spotter API (crt.sh is NOT used: its robots.txt disallows all bots).
  certspotter: { enabled: true, allowedMappings: ["explicit"], note: "tracked accounts only; ~10 lookups/hour without a key" },
  crtsh: { enabled: false, allowedMappings: [], note: "robots.txt: Disallow /" },
  // SEC EDGAR: fair-access policy, contact email in User-Agent (SEC_USER_AGENT); exact unique name matches only.
  sec_form_d: { enabled: true, allowedMappings: ["explicit"], note: "needs SEC_USER_AGENT with a contact email" },
  // Tool forums checked Nov 2026 and NOT used: n8n and Make community terms forbid automated access and monitoring.
  n8n_forum: { enabled: false, allowedMappings: [], note: "terms: no automated access or monitoring" },
  make_forum: { enabled: false, allowedMappings: [], note: "terms: no automated access or monitoring" },
  // Web search (Serper API, Google results): only the result's title + snippet is read; LinkedIn / X pages are never
  // fetched (terms + robots). Authors map from the post text only, never via their profiles.
  web_search: { enabled: true, allowedMappings: ["explicit"], note: "search API snippets only; result pages never fetched" },
  // India-first company lists, checked Nov 2026 and NOT used: Startup India's recognised-startup search needs a login
  // and the site is "All Rights Reserved" with no data licence or API; data.gov.in and mca.gov.in refused automated
  // fetches (403, even robots.txt); Karnataka's startup portal didn't resolve. Kerala Startup Mission allows all bots
  // but its listing lives on another host whose terms weren't checked. Revisit with an official dataset or written consent.
  startupindia: { enabled: false, allowedMappings: [], note: "listing behind login; all rights reserved, no data licence" },
  datagovin: { enabled: false, allowedMappings: [], note: "403 to automated fetches" },
  mca: { enabled: false, allowedMappings: [], note: "403 to automated fetches; no free incorporation list confirmed" },
  karnataka_startup: { enabled: false, allowedMappings: [], note: "portal did not resolve" },
  kerala_startup_mission: { enabled: false, allowedMappings: [], note: "robots allows all; listing host's terms unchecked" },
  // Funding news (Nov 2026): Serper's news API (Google News results): headline, link, date and outlet only; articles
  // are never fetched. Google News RSS itself is NOT used: news.google.com/robots.txt disallows everything but the home
  // and topic pages, and names AI crawlers (ClaudeBot, GPTBot) with Disallow: /.
  funding_news: { enabled: true, allowedMappings: ["explicit"], note: "news search API: headline + link only; domain proven by company search" },
  google_news_rss: { enabled: false, allowedMappings: [], note: "robots.txt disallows /rss and blocks AI crawlers" },
  // Niche public records (Nov 2026, pnpm niche). Official APIs meant for programmatic use; records name companies, and a
  // company becomes an account only when a company search proves its website (never a name guess).
  // openFDA: CC0 data, terms (open.fda.gov/terms) allow automated use within rate limits (1,000/day without a key).
  openfda: { enabled: true, allowedMappings: ["explicit"], note: "api.fda.gov only; fda.gov pages (DMF list) refuse bots and are not fetched" },
  // USASpending: public API, no key, no automated-access ban.
  usaspending: { enabled: true, allowedMappings: ["explicit"], note: "api.usaspending.gov public API" },
  // CMS Provider Data Catalog: public datastore API (data.cms.gov/provider-data/api), no key.
  cms_provider_data: { enabled: true, allowedMappings: ["explicit"], note: "provider-data datastore API" },
  // Socrata open-data portals (city building permits, data.transportation.gov FMCSA census): public SODA API, no key
  // needed (SOCRATA_APP_TOKEN, free, raises the throttle); datasets are published for reuse.
  socrata: { enabled: true, allowedMappings: ["explicit"], note: "SODA API /resource endpoints only" },
  // NPPES weekly incremental file (download.cms.gov): public CMS data dissemination file, no key.
  nppes: { enabled: true, allowedMappings: ["explicit"], note: "weekly NPI file; organisations only" },
  // SAM.gov entity API (SAM_API_KEY, public data only; personal keys: 10 requests a day, two used per run).
  sam: { enabled: true, allowedMappings: ["explicit"], note: "public entity data via extract; 2 requests a day" },
  // Google Places / Serper places: only the website is read, and only to find the company's own domain (then checked
  // on its own homepage); no other Places content is stored.
  maps: { enabled: true, allowedMappings: ["explicit"], note: "website field only, verified on the company's own site" },
  // Operator-supplied exports (pnpm niche import <csv>): rows the operator downloaded under their own access (GeM, CPPP,
  // RERA, PARIVESH, customs data from a paid provider). Local only: the file never enters the repo or CI.
  niche_import: { enabled: true, allowedMappings: ["explicit"], note: "operator's own exports, local only" },
  // India tender / project portals checked Nov 2026 and NOT fetched: GeM (bidplus) needs a CSRF token per session;
  // CPPP search sits behind a captcha; PARIVESH and state RERA portals are JS apps with captchas; NSE blocks clients
  // without a browser session. Paid aggregators (Tender247, TenderTiger, BidAssist) or manual exports via niche import.
  gem: { enabled: false, allowedMappings: [], note: "CSRF-protected API: not bypassed" },
  cppp: { enabled: false, allowedMappings: [], note: "captcha on search" },
  parivesh: { enabled: false, allowedMappings: [], note: "JS app + captcha" },
  rera: { enabled: false, allowedMappings: [], note: "state portals use captchas" },
  fda_web: { enabled: false, allowedMappings: [], note: "fda.gov refuses automated requests (Akamai)" },
  hubspot_community: { enabled: false, allowedMappings: [], note: "terms page needs JS; HubSpot site terms bar robots" },
};

export function isSourceEnabled(sourceId: string): boolean {
  return SOURCE_POLICY[sourceId]?.enabled ?? true;
}

/** Unknown sources get the strictest mapping rule until a policy is written for them. */
export function isMappingAllowed(sourceId: string, method: MappingConfidence): boolean {
  return (SOURCE_POLICY[sourceId]?.allowedMappings ?? ["explicit"]).includes(method);
}
