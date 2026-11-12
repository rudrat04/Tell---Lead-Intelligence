import type { RawItem } from "@tell/watchers";
import { isMappingAllowed, type MappingConfidence } from "@tell/watchers";
import type { PostExtraction } from "@tell/extract";
import { rawCandidates, filterCandidates, chooseDomain, nameMatchesDomain, registrableDomain, type DomainLists, type Candidate } from "./domains.js";
import type { HomepageCheck } from "./web.js";

/** Network calls the resolver needs, injectable for tests. */
export interface ResolverNet {
  checkHomepage(domain: string): Promise<HomepageCheck>;
  expandShortUrl(url: string): Promise<string | null>;
  fetchProfileText(platform: string, handle: string): Promise<string | null>;
}

export type Resolution =
  | { kind: "account"; domain: string; confidence: Exclude<MappingConfidence, "hint">; method: string; evidenceUrl: string }
  /** person lead: no account; may carry a low-confidence hint that never feeds account scores */
  | { kind: "person"; platform: string; handle: string; hint?: { domain: string; evidenceUrl: string }; reason: string }
  /** no domain and no author to follow up with */
  | { kind: "unresolved"; reason: string };

/** Map item source -> author platform for person leads and author mappings. */
const PLATFORM: Record<string, string> = { hn: "hn", reddit: "reddit", "forhire-subs": "reddit" };

async function expand(shortened: Candidate[], net: ResolverNet): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const s of shortened.slice(0, 3)) {
    const dest = await net.expandShortUrl(s.url!).catch(() => null);
    const d = dest && registrableDomain(dest);
    if (d) out.push({ domain: d, via: "url", url: dest! });
  }
  return out;
}

async function domainFromText(text: string, companyName: string | null, lists: DomainLists, net: ResolverNet) {
  const { company, shortened } = filterCandidates(rawCandidates(text), lists);
  const all = shortened.length ? filterCandidates([...company, ...(await expand(shortened, net))], lists).company : company;
  return chooseDomain(all, companyName);
}

/**
 * Entity resolution (plan 8a). The domain is the account key; nothing is guessed.
 * Order: source-provided domain (ATS) -> the post itself -> the author's profile (if the source's terms allow).
 * Unmapped posts with an author become person leads.
 */
export async function resolveItem(item: RawItem, x: PostExtraction, lists: DomainLists, net: ResolverNet): Promise<Resolution> {
  const sourceDomain = typeof item.meta.domain === "string" ? registrableDomain(item.meta.domain) : null;
  if (sourceDomain) return { kind: "account", domain: sourceDomain, confidence: "explicit", method: "source", evidenceUrl: item.url };

  // 1. The post itself: a linked site, an email address, or a bare domain
  if (isMappingAllowed(item.sourceId, "explicit")) {
    const pick = await domainFromText(`${item.title ?? ""}\n${item.text}`, x.company_name, lists, net);
    if (pick) {
      const home = await net.checkHomepage(pick.domain);
      if (home.ok) return { kind: "account", domain: home.finalDomain ?? pick.domain, confidence: "explicit", method: `post:${pick.via}`, evidenceUrl: item.url };
    }
  }

  const platform = PLATFORM[item.sourceId];
  if (!item.author || !platform) return { kind: "unresolved", reason: "no confident domain in post and no author" };

  // 2. The author's own profile (HN "about"). Gated per source: Reddit authors are never followed off the post.
  if (isMappingAllowed(item.sourceId, "profile")) {
    const about = await net.fetchProfileText(platform, item.author).catch(() => null);
    if (about) {
      const pick = await domainFromText(about, null, lists, net);
      if (pick) {
        const home = await net.checkHomepage(pick.domain);
        if (home.ok) {
          const domain = home.finalDomain ?? pick.domain;
          // A profile link may be a personal site or a past employer: if the post names a different company, it's only a hint.
          if (x.company_name && !nameMatchesDomain(x.company_name, domain)) {
            return { kind: "person", platform, handle: item.author, hint: { domain, evidenceUrl: item.url }, reason: "profile domain does not match named company" };
          }
          return { kind: "account", domain, confidence: "profile", method: "profile", evidenceUrl: item.url };
        }
      }
    }
  }

  return { kind: "person", platform, handle: item.author, reason: "author not mapped to a company" };
}

/** Signal type from the extraction; class and half-life come from signals.yaml. */
export function signalTypeFor(x: PostExtraction): string {
  return x.ask_type === "hire" ? "explicit_hire_request" : "pain_post";
}
