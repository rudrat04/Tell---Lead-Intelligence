/**
 * Region and agency checks for job boards found outside YC (Keka, Freshteam, Workable, JSearch, portfolios).
 * The ATS says nothing about the company's region (Keka and Freshteam have Gulf, African and US customers),
 * so the region comes from where the roles are.
 */

export const INDIA_LOCATION = /\b(india|bengaluru|bangalore|mumbai|navi mumbai|thane|pune|hyderabad|chennai|gurgaon|gurugram|noida|delhi|new delhi|ncr|kolkata|ahmedabad|jaipur|kochi|cochin|indore|chandigarh|coimbatore|trivandrum|thiruvananthapuram|vadodara|surat|nagpur|lucknow|bhubaneswar|mohali|mysore|mysuru|visakhapatnam|vizag)\b/i;

export interface LocatedPosting { location?: string; countryCodes?: string[] }

/**
 * Countries a role's location can name, with the region names accounts already use (YC's spelling). India first: on a
 * tie it wins, so India detection is exactly what it was. Only unambiguous words: no "US"/"CA" text (they match "join us",
 * "CA" for California), no cities that exist in two countries (Cambridge, Waterloo is only Ontario's).
 */
const COUNTRIES: { name: string; codes: string[]; re: RegExp }[] = [
  { name: "India", codes: ["IN"], re: INDIA_LOCATION },
  { name: "United States of America", codes: ["US", "USA"], re: /\b(united states|u\.s\.a\.?|usa|new york|nyc|san francisco|bay area|los angeles|seattle|boston|austin|chicago|denver|atlanta|miami|dallas|houston|palo alto|mountain view|menlo park|san jose|san diego|washington,? d\.?c\.?)\b/i },
  { name: "United Kingdom", codes: ["GB", "UK"], re: /\b(united kingdom|uk|england|scotland|wales|london|manchester|edinburgh|glasgow|bristol|birmingham, uk|leeds)\b/i },
  { name: "Canada", codes: ["CA"], re: /\b(canada|toronto|vancouver|montreal|montréal|ottawa|calgary|edmonton|waterloo, on)\b/i },
  { name: "United Arab Emirates", codes: ["AE"], re: /\b(united arab emirates|uae|dubai|abu dhabi|sharjah)\b/i },
  { name: "Saudi Arabia", codes: ["SA"], re: /\b(saudi arabia|ksa|riyadh|jeddah|dammam|khobar)\b/i },
  { name: "Qatar", codes: ["QA"], re: /\b(qatar|doha)\b/i },
  { name: "Bahrain", codes: ["BH"], re: /\b(bahrain|manama)\b/i },
  { name: "Oman", codes: ["OM"], re: /\b(oman|muscat)\b/i },
  { name: "Kuwait", codes: ["KW"], re: /\bkuwait\b/i },
  { name: "Singapore", codes: ["SG"], re: /\bsingapore\b/i },
  { name: "Malaysia", codes: ["MY"], re: /\b(malaysia|kuala lumpur|penang)\b/i },
  { name: "Indonesia", codes: ["ID"], re: /\b(indonesia|jakarta)\b/i },
  { name: "Vietnam", codes: ["VN"], re: /\b(vietnam|viet nam|ho chi minh|hanoi)\b/i },
  { name: "Thailand", codes: ["TH"], re: /\b(thailand|bangkok)\b/i },
  { name: "Philippines", codes: ["PH"], re: /\b(philippines|manila|makati|cebu|taguig)\b/i },
];

/** The country a posting is in: its country codes first, then its location text; null = none we know. */
export function countryOf(p: LocatedPosting): string | null {
  const codes = (p.countryCodes ?? []).map((c) => c.toUpperCase());
  for (const c of COUNTRIES) if (c.codes.some((x) => codes.includes(x))) return c.name;
  for (const c of COUNTRIES) if (c.re.test(p.location ?? "")) return c.name;
  return null;
}

const located = (p: LocatedPosting) => (p.countryCodes?.length ?? 0) > 0 || !!p.location?.trim();

/**
 * The country at least half the roles with a location are in (India wins a tie); otherwise null (unknown, not guessed).
 * Region names match the ones accounts already carry, so `icp.hard_filters.regions_any` applies to every source.
 */
export function regionFromPostings(postings: LocatedPosting[]): string | null {
  const withLoc = postings.filter(located);
  if (!withLoc.length) return null;
  const counts = new Map<string, number>();
  for (const p of withLoc) { const c = countryOf(p); if (c) counts.set(c, (counts.get(c) ?? 0) + 1); }
  // COUNTRIES order breaks ties, so India is chosen first
  for (const c of COUNTRIES) if ((counts.get(c.name) ?? 0) / withLoc.length >= 0.5) return c.name;
  return null;
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
