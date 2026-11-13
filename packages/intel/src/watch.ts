import { toRegex, type Pack } from "@tell/config";

/**
 * Change detection for the weekly account watch (plan 5b + 5c). Pure functions, no I/O.
 * Rules learned the hard way on job boards apply here too:
 *  - the first snapshot of an account is a baseline: it records state and emits no "change" events;
 *  - evidence URLs are unique per event (the signals table is unique on url + type), e.g. https://acme.com/#tool=hubspot.
 */

export interface ToolRules { sprawlMin: number; sprawlExclude?: string[]; overlap?: string[]; tools: { key: string; label: string; category: string; site: RegExp[]; dns: RegExp[] }[] }

export function compileTools(t: Pack["tools"]): ToolRules {
  return {
    sprawlMin: t.sprawl_min, sprawlExclude: t.sprawl_exclude_categories ?? [], overlap: t.overlap_categories ?? [],
    tools: Object.entries(t.tools).map(([key, v]) => ({ key, label: v.label, category: v.category, site: v.site.map(toRegex), dns: v.dns.map(toRegex) })),
  };
}

export function toolsFromTxt(txt: string[], rules: ToolRules): string[] {
  const all = txt.join("\n");
  return rules.tools.filter((t) => t.dns.some((r) => r.test(all))).map((t) => t.key).sort();
}

export interface SiteState { salesLed: boolean; selfServe: boolean; pricing: boolean; tools: string[]; ctas?: string[]; leakyForms?: string[]; partnerBadge?: boolean; agencyCredit?: string | null }

export interface WatchEvent {
  type: "cta_sales_led" | "pricing_page_added" | "gtm_tool_added" | "stack_sprawl" | "tool_overlap" | "leaky_capture" | "has_gtm_agency" | "funding_raise" | "product_launch";
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
    for (const t of cur.tools.filter((t) => !prev.tools.includes(t))) {
      out.push({ type: "gtm_tool_added", quote: `Added ${toolLabel(t, rules)} (website)`, url: `${base}#tool=${t}`, observedAt: now });
    }
  }
  return out;
}

/** DNS diff (TXT records): new tool includes / verifications. `prev` null = baseline. */
export function diffDnsTools(domain: string, prev: string[] | null, cur: string[], rules: ToolRules, now: Date): WatchEvent[] {
  if (!prev) return [];
  return cur.filter((t) => !prev.includes(t)).map((t) => ({
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
