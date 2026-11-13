/**
 * Region and agency checks for job boards found outside YC (Keka, Freshteam tenants).
 * The ATS says nothing about the company's region (Keka and Freshteam have Gulf, African and US customers),
 * so the region comes from where the roles are.
 */

export const INDIA_LOCATION = /\b(india|bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|chennai|gurgaon|gurugram|noida|delhi|new delhi|ncr|kolkata|ahmedabad|jaipur|kochi|cochin|indore|chandigarh|coimbatore|trivandrum|thiruvananthapuram|vadodara|surat|nagpur|lucknow|bhubaneswar|mohali|mysore|mysuru|visakhapatnam|vizag)\b/i;

export interface LocatedPosting { location?: string; countryCodes?: string[] }

const inIndia = (p: LocatedPosting) => (p.countryCodes ?? []).some((c) => c.toUpperCase() === "IN") || INDIA_LOCATION.test(p.location ?? "");
const located = (p: LocatedPosting) => (p.countryCodes?.length ?? 0) > 0 || !!p.location?.trim();

/** "India" when at least half the roles with a location are in India; otherwise null (unknown, not guessed). */
export function regionFromPostings(postings: LocatedPosting[]): string | null {
  const withLoc = postings.filter(located);
  if (!withLoc.length) return null;
  return withLoc.filter(inIndia).length / withLoc.length >= 0.5 ? "India" : null;
}

const AGENCY_TEXT = /\b(for (one of )?our clients?\b|on behalf of (our|a|one of our) clients?|our client(,)? (is|a|an)\b|for a leading client|client of ours)/i;
const AGENCY_NAME = /\b(staffing|recruit\w*|manpower|placements?|hr solutions|talent|headhunt\w*|executive search)\b/i;

/**
 * Recruiting/staffing firms post their clients' roles on their own board: the company hiring isn't them.
 * A board counts as an agency when its name says so, or a third of its role texts say "for our client".
 */
export function looksLikeStaffing(name: string | null, texts: (string | undefined)[]): boolean {
  if (name && AGENCY_NAME.test(name)) return true;
  const t = texts.filter((x): x is string => !!x && x.length > 20);
  if (!t.length) return false;
  return t.filter((x) => AGENCY_TEXT.test(x)).length / t.length >= 1 / 3;
}
