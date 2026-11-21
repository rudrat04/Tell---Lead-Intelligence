import { toRegex, type Pack } from "@tell/config";

/**
 * Change detection for the weekly account watch (plan 5b + 5c). Pure functions, no I/O.
 * Rules learned the hard way on job boards apply here too:
 *  - the first snapshot of an account is a baseline: it records state and emits no "change" events;
 *  - evidence URLs are unique per event (the signals table is unique on url + type), e.g. https://acme.com/#tool=hubspot.
 */

export interface ToolRules { sprawlMin: number; sprawlExclude?: string[]; overlap?: string[]; outbound?: string[]; analytics?: string[]; tools: { key: string; label: string; category: string; site: RegExp[]; dns: RegExp[] }[] }

export function compileTools(t: Pack["tools"]): ToolRules {
  return {
    sprawlMin: t.sprawl_min, sprawlExclude: t.sprawl_exclude_categories ?? [], overlap: t.overlap_categories ?? [],
    outbound: t.outbound_categories ?? ["outbound"], analytics: t.analytics_categories ?? ["analytics"],
    tools: Object.entries(t.tools).map(([key, v]) => ({ key, label: v.label, category: v.category, site: v.site.map(toRegex), dns: v.dns.map(toRegex) })),
  };
}

export function toolsFromTxt(txt: string[], rules: ToolRules): string[] {
  const all = txt.join("\n");
  return rules.tools.filter((t) => t.dns.some((r) => r.test(all))).map((t) => t.key).sort();
}

export interface SiteState { salesLed: boolean; selfServe: boolean; pricing: boolean; tools: string[]; ctas?: string[]; leakyForms?: string[]; partnerBadge?: boolean; agencyCredit?: string | null; contentLinks?: string[] }

export interface WatchEvent {
  type: "cta_sales_led" | "pricing_page_added" | "gtm_tool_added" | "stack_sprawl" | "tool_overlap" | "leaky_capture" | "has_gtm_agency" | "funding_raise" | "product_launch" | "tool_sunset"
    | "email_auth_gap" | "attribution_gap" | "site_health_poor" | "content_motion";
  quote: string;
  url: string;
  observedAt: Date;
}

const toolLabel = (key: string, rules: ToolRules) => rules.tools.find((t) => t.key === key)?.label ?? key;

/** Website diff. `prev` null = baseline (state only). */
export function diffSite(domain: string, prev: SiteState | null, cur: SiteState, rules: ToolRules, now: Date): WatchEvent[] {
  const out: WatchEvent[] = [];
  const base = `https://${domain}/`;
  if (prev) {
    if (cur.salesLed && !prev.salesLed) {
      const cta = cur.ctas?.find((c) => /demo|sales|call|consult|expert|team/i.test(c)) ?? "Book a demo";
      out.push({ type: "cta_sales_led", quote: `Homepage now says "${cta}"${prev.selfServe ? " (was self-serve)" : ""}`, url: `${base}#cta=sales-led`, observedAt: now });
    }
    if (cur.pricing && !prev.pricing) out.push({ type: "pricing_page_added", quote: "Pricing page now linked from the homepage", url: `${base}#pricing`, observedAt: now });
    // a content channel that wasn't linked before (snapshots from before contentLinks existed say nothing: no event)
    if (prev.contentLinks) {
      const added = (cur.contentLinks ?? []).filter((c) => !prev.contentLinks!.includes(c));
      if (added.length) out.push({ type: "content_motion", quote: `Started linking a ${added.join(" and ")} from the homepage`, url: `${base}#content=${added.join("+")}`, observedAt: now });
    }
    // analytics tags aren't GTM tools: adding them to the pack must not announce "added Google Analytics" everywhere
    const quiet = (k: string) => (rules.analytics ?? []).includes(rules.tools.find((t) => t.key === k)?.category ?? "");
    for (const t of cur.tools.filter((t) => !prev.tools.includes(t) && !quiet(t))) {
      out.push({ type: "gtm_tool_added", quote: `Added ${toolLabel(t, rules)} (website)`, url: `${base}#tool=${t}`, observedAt: now });
    }
  }
  return out;
}

/** DNS diff (TXT records): new tool includes / verifications. `prev` null = baseline. */
export function diffDnsTools(domain: string, prev: string[] | null, cur: string[], rules: ToolRules, now: Date): WatchEvent[] {
  if (!prev) return [];
  const quiet = (k: string) => (rules.analytics ?? []).includes(rules.tools.find((t) => t.key === k)?.category ?? "");
  return cur.filter((t) => !prev.includes(t) && !quiet(t)).map((t) => ({
    type: "gtm_tool_added" as const, quote: `Added ${toolLabel(t, rules)} (DNS record)`, url: `https://${domain}/#tool=${t}`, observedAt: now,
  }));
}

/** Stack sprawl is a state: this many GTM tools at once (site and DNS combined). One event per account (unique URL). */
export function stackSprawl(domain: string, tools: string[], rules: ToolRules, now: Date): WatchEvent | null {
  const cat = (k: string) => rules.tools.find((t) => t.key === k)?.category ?? "";
  const uniq = [...new Set(tools)].filter((t) => !(rules.sprawlExclude ?? []).includes(cat(t)));
  if (uniq.length < rules.sprawlMin) return null;
  return { type: "stack_sprawl", quote: `${uniq.length} GTM tools: ${uniq.map((t) => toolLabel(t, rules)).join(", ")}`, url: `https://${domain}/#stack`, observedAt: now };
}

/** Two or more tools doing the same job (two CRMs, two email platforms): real sprawl, not just many tools. One event per account. */
export function toolOverlap(domain: string, tools: string[], rules: ToolRules, now: Date): WatchEvent | null {
  const by = new Map<string, string[]>();
  for (const k of new Set(tools)) {
    const c = rules.tools.find((t) => t.key === k)?.category;
    if (c && (rules.overlap ?? []).includes(c)) by.set(c, [...(by.get(c) ?? []), k]);
  }
  const dup = [...by].filter(([, ks]) => ks.length >= 2);
  if (!dup.length) return null;
  const quote = dup.map(([c, ks]) => `${ks.length} ${c.replace(/_/g, " ")} tools: ${ks.map((k) => toolLabel(k, rules)).join(", ")}`).join("; ");
  return { type: "tool_overlap", quote, url: `https://${domain}/#overlap`, observedAt: now };
}

/**
 * Leaky lead capture: the site's form sends leads to email or a form tool, and no CRM or marketing automation shows on
 * the site or in DNS. (A CRM loaded some other way can hide; the form-sink check keeps false positives down.)
 */
export function leakyCapture(domain: string, leakyForms: string[], tools: string[], rules: ToolRules, now: Date, crmCategories = ["crm", "marketing_automation"]): WatchEvent | null {
  if (!leakyForms.length) return null;
  if (tools.some((k) => crmCategories.includes(rules.tools.find((t) => t.key === k)?.category ?? ""))) return null;
  const sink = leakyForms.map((f) => (f === "mailto" ? "an email address" : f)).join(", ");
  return { type: "leaky_capture", quote: `Site form sends leads to ${sink}; no CRM detected`, url: `https://${domain}/#capture`, observedAt: now };
}

/** An outside GTM agency credited on the site ("marketing by Acme"): they may already have help. Weak: credits are often old. */
export function agencyCredited(domain: string, credit: string | null | undefined, now: Date): WatchEvent | null {
  return credit ? { type: "has_gtm_agency", quote: `Credits ${credit} for marketing/growth`, url: `https://${domain}/#agency`, observedAt: now } : null;
}

/** Funding headlines need a round word or an amount; "raises the bar" doesn't count. */
const FUNDING = /\b(raises?|raised|secures?|secured|bags?|lands?|closes?|announces?)\b[^.]{0,80}?(\$|€|£|₹|rs\.?\s?|inr\s?|usd\s?)\s?\d[\d.,]*\s?(k|m|mn|million|b|bn|billion|cr|crore|lakh)?\b|\b(pre-seed|seed round|seed funding|series [a-f]\b|funding round)\b/i;

export function isFundingHeadline(title: string): boolean {
  return FUNDING.test(title);
}

/** Dated facts from a YC company page. Not "changes", so no baseline needed: the real date makes old news decay. */
export function eventsFromYcProfile(
  p: { news: { title: string; url: string; date?: string }[]; launches: { title: string; url: string; createdAt?: string }[] },
  now: Date, maxAgeDays = 180,
): WatchEvent[] {
  const out: WatchEvent[] = [];
  const recent = (d: Date) => !Number.isNaN(d.getTime()) && d <= now && now.getTime() - d.getTime() <= maxAgeDays * 86_400_000;
  for (const n of p.news) {
    // YC shows "Oct 20, 2026": parse as UTC so the date doesn't shift with the machine's timezone
    const d = n.date ? new Date(/\d{4}$/.test(n.date.trim()) ? `${n.date.trim()} 00:00 UTC` : n.date) : new Date(NaN);
    if (recent(d) && isFundingHeadline(n.title)) out.push({ type: "funding_raise", quote: n.title, url: n.url, observedAt: d });
  }
  for (const l of p.launches) {
    const d = l.createdAt ? new Date(l.createdAt) : new Date(NaN);
    if (recent(d)) out.push({ type: "product_launch", quote: `Launched: ${l.title}`, url: l.url, observedAt: d });
  }
  return out;
}

/** SDR/BDR-style titles: someone is about to send a lot of cold email. */
export const OUTBOUND_TITLE = /\b(sdr|bdr|sales development|business development (rep|representative|executive|associate)|outbound|lead generation (executive|specialist|associate))\b/i;

/**
 * Email authentication problems on a domain that sends (or is about to send) cold email. Gmail and Yahoo require SPF,
 * DKIM and a DMARC record from bulk senders since 2024: without them outbound lands in spam. Only definite findings:
 *  - no DMARC record (`p=none` is a record and meets the requirement, so it isn't flagged);
 *  - no SPF record, two SPF records (invalid), or SPF ending in `+all` (anyone may send as them).
 * DKIM isn't checked (selectors can't be listed). `rootTxt` / `dmarcTxt` null = lookup failed: nothing is said.
 * `outbound` says why sending matters ("Hiring 2 SDRs", "Runs Apollo"); without it there is no signal.
 */
export function emailAuthGap(domain: string, rootTxt: string[] | null, dmarcTxt: string[] | null, outbound: string | null, now: Date, url = `https://${domain}/#email-auth`): WatchEvent | null {
  if (!outbound || !rootTxt || !dmarcTxt) return null;
  const gaps: string[] = [];
  if (!dmarcTxt.some((t) => /^v=DMARC1\b/i.test(t.trim()))) gaps.push("no DMARC record");
  const spf = rootTxt.filter((t) => /^v=spf1\b/i.test(t.trim()));
  if (!spf.length) gaps.push("no SPF record");
  else if (spf.length > 1) gaps.push(`${spf.length} SPF records (only one is allowed)`);
  else if (/\s\+all\b/i.test(spf[0]!)) gaps.push("an SPF record that lets anyone send as them (+all)");
  if (!gaps.length) return null;
  return { type: "email_auth_gap", quote: `${outbound}, but ${domain} has ${gaps.join(" and ")}`, url, observedAt: now };
}

/** Tools (keys) in the given categories, as labels. */
export function toolsInCategories(tools: string[], categories: string[], rules: ToolRules): string[] {
  return [...new Set(tools)].filter((k) => categories.includes(rules.tools.find((t) => t.key === k)?.category ?? "")).map((k) => toolLabel(k, rules));
}

/**
 * Sales-led site whose demo form doesn't ask how the visitor found them: word of mouth, a colleague's post, a podcast
 * mention ("dark social") is invisible to their analytics, and asking is the only cheap fix. Only readable plain-HTML
 * forms with an email field and 3+ fields count (a newsletter box isn't a demo form); an embed we can't read says nothing.
 */
export function attributionGap(domain: string, salesLed: boolean, forms: { fields: number; hasEmail: boolean; asksSource: boolean }[], pageUrl: string, now: Date): WatchEvent | null {
  if (!salesLed) return null;
  const form = forms.find((f) => f.hasEmail && f.fields >= 3);
  if (!form || form.asksSource) return null;
  return { type: "attribution_gap", quote: `Demo form asks for ${form.fields} details but never how the visitor heard about them (${pageUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")})`, url: `https://${domain}/#attribution`, observedAt: now };
}

/** PageSpeed result for one run (mobile). */
export interface SpeedRun { score: number; lcpMs: number | null; at: string }

/**
 * Slow site, from two PageSpeed runs in a row that agree (one run is noisy): mobile performance below `maxScore` both
 * times. The quote adds "no analytics tag" when the homepage shows none (said only next to the speed finding, never alone).
 */
export function siteHealthPoor(domain: string, runs: SpeedRun[], noAnalytics: boolean, now: Date, maxScore = 50): WatchEvent | null {
  const [cur, prev] = runs;
  if (!cur || !prev || cur.score >= maxScore || prev.score >= maxScore) return null;
  const lcp = cur.lcpMs ? `, main content shows after ${(cur.lcpMs / 1000).toFixed(1)}s on mobile` : "";
  return { type: "site_health_poor", quote: `Mobile PageSpeed ${Math.round(cur.score)}/100${lcp}${noAnalytics ? "; no analytics tag on the homepage" : ""}`, url: `https://${domain}/#speed`, observedAt: now };
}

/** A tool that stopped (or stops) working, still on their site or DNS (tools.yaml `sunsets`): a state, one per tool
 *  (pure; exported for tests). Universal Analytics still loading = a site measuring nothing since July 2023. */
export function toolSunsets(domain: string, tools: string[], sunsets: { tool: string; ended: string; url: string; note: string }[], labels: Record<string, { label: string }>, now: Date): WatchEvent[] {
  const have = new Set(tools);
  return sunsets.filter((x) => have.has(x.tool)).map((x) => ({
    type: "tool_sunset" as const,
    quote: `${domain} still loads ${labels[x.tool]?.label ?? x.tool}, which stopped working on ${x.ended}: ${x.note} (${x.url}).`,
    url: `https://${domain}/#sunset-${x.tool}`, observedAt: now,
  }));
}
