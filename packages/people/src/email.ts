/**
 * Email engine, pure part (plan 9b). Learns a company's address pattern from addresses seen in public
 * (its own site, its GitHub org's commits) and applies it to the people we know there.
 *
 * Status, strongest first:
 *   observed: this exact address was seen in public for this person
 *   likely:   built from a pattern learned from at least one name-matched address at this domain
 *   guessed:  the domain receives mail but no pattern is known; built from the common default for the company size
 *   invalid:  the domain does not receive mail (no MX or a null MX), or a bounce came back
 * No SMTP probing: it is unreliable (catch-alls, greylisting) and looks like abuse.
 */

export type EmailStatus = "observed" | "likely" | "guessed" | "invalid";

export const PATTERNS = ["first", "first.last", "firstlast", "flast", "f.last", "first_last", "firstl", "last", "last.first"] as const;
export type Pattern = (typeof PATTERNS)[number];

/** Mailboxes that are never a person (they are still a usable channel: see genericAddress). */
const ROLE_LOCAL = /^(info|hello|hi|hey|contact|support|help|sales|team|admin|office|careers|jobs|hr|press|media|founders?|billing|accounts?|legal|privacy|security|abuse|noreply|no-reply|donotreply|marketing|partners?|feedback|enquir(y|ies)|inquir(y|ies)|webmaster|postmaster|dev|engineering|ops|mail)$/i;

export const isRoleAddress = (address: string) => ROLE_LOCAL.test(address.split("@")[0] ?? "");

/** ASCII letters only, lowercased; null when the name can't make a mailbox. */
function nameParts(fullName: string): { first: string; last: string | null } | null {
  const tokens = fullName.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/\([^)]*\)/g, " ")
    .toLowerCase().split(/[\s-]+/).map((t) => t.replace(/[^a-z]/g, "")).filter((t) => t.length > 0);
  if (!tokens.length || tokens[0]!.length < 2) return null;
  const last = tokens.length > 1 ? tokens[tokens.length - 1]! : null;
  return { first: tokens[0]!, last: last && last.length >= 2 ? last : null };
}

/** The local part for a name under a pattern, or null if the pattern needs a last name we don't have. */
export function localPart(pattern: Pattern, fullName: string): string | null {
  const n = nameParts(fullName);
  if (!n) return null;
  const { first, last } = n;
  if (pattern === "first") return first;
  if (!last) return null;
  switch (pattern) {
    case "first.last": return `${first}.${last}`;
    case "firstlast": return `${first}${last}`;
    case "flast": return `${first[0]}${last}`;
    case "f.last": return `${first[0]}.${last}`;
    case "first_last": return `${first}_${last}`;
    case "firstl": return `${first}${last[0]}`;
    case "last": return last;
    case "last.first": return `${last}.${first}`;
  }
}

/** Which patterns turn this name into this local part (several when ambiguous, e.g. a one-word name). */
export function patternsFor(local: string, fullName: string): Pattern[] {
  const l = local.toLowerCase();
  return PATTERNS.filter((p) => localPart(p, fullName) === l);
}

export interface SeenAddress { address: string; sourceUrl: string }
export interface LearnedPattern { pattern: Pattern; confidence: number; support: number }

/**
 * Learn the domain's pattern from addresses seen on it, matched against people known at the account.
 * Only name-matched addresses count: an address we can't tie to a name tells us nothing about the pattern.
 * Ambiguous matches (an address fitting several patterns) split their vote.
 */
export function learnPattern(seen: SeenAddress[], names: string[], domain: string): LearnedPattern | null {
  const votes = new Map<Pattern, number>();
  let total = 0;
  const d = domain.toLowerCase();
  for (const s of new Set(seen.map((x) => x.address.toLowerCase()))) {
    const [local, host] = s.split("@");
    if (!local || host !== d || isRoleAddress(s)) continue;
    const hits = new Set<Pattern>();
    for (const n of names) for (const p of patternsFor(local, n)) hits.add(p);
    if (!hits.size) continue;
    total++;
    for (const p of hits) votes.set(p, (votes.get(p) ?? 0) + 1 / hits.size);
  }
  if (!total) return null;
  const [pattern, v] = [...votes].sort((a, b) => b[1] - a[1] || PATTERNS.indexOf(a[0]) - PATTERNS.indexOf(b[0]))[0]!;
  return { pattern, confidence: Math.round((v / total) * 100) / 100, support: total };
}

export interface DomainMailInfo {
  /** null = could not check (DNS down); false = does not receive mail */
  acceptsMail: boolean | null;
  provider: string | null;
  pattern: LearnedPattern | null;
}

export interface EmailGuess { address: string; status: EmailStatus; source: string; note: string }

/** Small teams usually give people first@; larger ones first.last@. Used only when no pattern was learned. */
export function defaultPattern(sizeBand: string | null): Pattern {
  const n = Number((sizeBand ?? "").match(/\d+/g)?.pop() ?? NaN);
  return Number.isFinite(n) && n <= 50 ? "first" : "first.last";
}

/** Minimum agreement before a learned pattern is called "likely". */
export const LIKELY_CONFIDENCE = 0.75;

/** The best address for one person, from what is known about the domain. Null when no address can be formed. */
export function emailFor(
  fullName: string, domain: string, mail: DomainMailInfo, seen: SeenAddress[], sizeBand: string | null,
): EmailGuess | null {
  const d = domain.toLowerCase();
  // observed: an address on this domain that fits this person's name under some pattern
  for (const s of seen) {
    const [local, host] = s.address.toLowerCase().split("@");
    if (local && host === d && !isRoleAddress(s.address) && patternsFor(local, fullName).length) {
      return { address: s.address.toLowerCase(), status: "observed", source: s.sourceUrl, note: "seen in public" };
    }
  }
  if (mail.acceptsMail === false) {
    const local = localPart(mail.pattern?.pattern ?? defaultPattern(sizeBand), fullName) ?? localPart("first", fullName);
    return local ? { address: `${local}@${d}`, status: "invalid", source: "dns", note: "domain does not receive mail" } : null;
  }
  const p = mail.pattern;
  if (p && p.confidence >= LIKELY_CONFIDENCE) {
    const local = localPart(p.pattern, fullName);
    if (local) return { address: `${local}@${d}`, status: "likely", source: "pattern", note: `${p.pattern}@ pattern from ${p.support} public address${p.support === 1 ? "" : "es"}` };
  }
  if (mail.acceptsMail === null) return null; // can't even confirm the domain takes mail: don't guess
  const fallback = defaultPattern(sizeBand);
  const local = localPart(fallback, fullName) ?? localPart("first", fullName);
  return local ? { address: `${local}@${d}`, status: "guessed", source: "default", note: `common ${fallback}@ format, unverified` } : null;
}

/** A shared mailbox seen on the site (founders@ beats hello@ beats info@), as a fallback channel. */
export function genericAddress(seen: SeenAddress[], domain: string): SeenAddress | null {
  const rank = ["founders", "founder", "hello", "hi", "contact", "team", "info", "sales"];
  const d = domain.toLowerCase();
  const roles = seen.filter((s) => s.address.toLowerCase().endsWith(`@${d}`) && isRoleAddress(s.address));
  const score = (s: SeenAddress) => { const i = rank.indexOf(s.address.split("@")[0]!.toLowerCase()); return i < 0 ? 99 : i; };
  return roles.filter((s) => score(s) < 99).sort((a, b) => score(a) - score(b))[0] ?? null;
}

/** Pull addresses on `domain` (or its subdomains collapsed to it) out of page text, including "name [at] domain" forms. */
export function extractAddresses(text: string, domain: string): string[] {
  const d = domain.toLowerCase().replace(/\./g, "\\.");
  const t = text.replace(/\s*(\[|\()\s*at\s*(\]|\))\s*/gi, "@").replace(/\s*(\[|\()\s*dot\s*(\]|\))\s*/gi, ".").replace(/%40/g, "@");
  const rx = new RegExp(`([a-z0-9][a-z0-9._+-]{0,63})@${d}\\b`, "gi");
  const out = new Set<string>();
  for (const m of t.matchAll(rx)) {
    const local = m[1]!.toLowerCase().replace(/\.+$/, "");
    if (/\.(png|jpe?g|gif|svg|webp)$/i.test(local) || /^[0-9a-f]{16,}$/.test(local)) continue; // asset names, hashes
    out.add(`${local.split("+")[0]}@${domain.toLowerCase()}`);
  }
  return [...out];
}

/** MX hosts → provider label (shown in the digest; Zoho matters for India). */
export function mailProvider(mxHosts: string[]): string | null {
  const h = mxHosts.join(" ").toLowerCase();
  if (!h) return null;
  if (/google\.com|googlemail\.com/.test(h)) return "google";
  if (/outlook\.com|microsoft/.test(h)) return "microsoft";
  if (/zoho\./.test(h)) return "zoho";
  if (/protonmail|proton\.me/.test(h)) return "proton";
  if (/secureserver\.net/.test(h)) return "godaddy";
  if (/mimecast|pphosted|barracuda/.test(h)) return "gateway";
  return "other";
}
