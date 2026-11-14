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

// hiring *for* a client, not serving clients: "we are hiring a sales head for our client" / "on behalf of our client", never
// "our algorithms reduce costs for our clients" (a company describing its own business)
const AGENCY_TEXT = /\b(hiring|recruiting|looking for|seeking)\b[^.]{0,60}?\bfor (one of )?(our|a|an) ([\w-]+ )?clients?\b|\bon behalf of (our|a|one of our) clients?|\bour client(,)? (is|a|an)\b|\bfor a leading client|\bclient of ours/i;
const AGENCY_NAME = /\b(staffing|recruit\w*|manpower|placements?|hr solutions|talent|headhunt\w*|executive search)\b/i;
/** A title that names someone else's company: "BD Manager - Hiring for Northwind Hospital", "(hiring for a leading NBFC)". */
const HIRING_FOR = /(?:^|[-–—|(:,]\s*)hiring for (?:a |an |one of (?:our )?)?([^()\-–—|,:]+)/i;
const CLIENT_WORDS = /^(leading|reputed|top|large|well[- ]known|fast[- ]growing|mnc|clients?)\b/i;
// "Hiring for" a place, a team or a shift is a normal company ("Hiring for Mumbai", "Hiring for Sales Team")
const NOT_A_CLIENT = /^(our|my|the|this|multiple|various|several|many|all|both|immediate|urgent|night|day|sales|marketing|growth|tech|team|india|remote|us|uk|usa|mumbai|bombay|bengaluru|bangalore|delhi|new delhi|ncr|gurgaon|gurugram|noida|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|kochi|indore|chandigarh|lucknow)\b/i;

/**
 * Recruiting/staffing firms post their clients' roles on their own board: the company hiring isn't them.
 * A board counts as an agency when its name says so, a third of its role texts say "for our client", or any role
 * title says who it is hiring for ("- Hiring for Northwind Hospital"): a company never names itself that way.
 */
export function looksLikeStaffing(name: string | null, texts: (string | undefined)[], titles: string[] = []): boolean {
  if (name && AGENCY_NAME.test(name)) return true;
  if (titles.some(agencyTitle)) return true;
  const t = texts.filter((x): x is string => !!x && x.length > 20);
  if (!t.length) return false;
  return t.filter((x) => AGENCY_TEXT.test(x)).length / t.length >= 1 / 3;
}

/** "Sales Manager - Hiring for Northwind Hospital (Mumbai)": the title names the client. */
export function agencyTitle(title: string): boolean {
  const who = title.match(HIRING_FOR)?.[1]?.trim();
  if (!who) return false;
  if (CLIENT_WORDS.test(who)) return true;
  return !NOT_A_CLIENT.test(who) && /^[A-Z0-9]/.test(who);
}
