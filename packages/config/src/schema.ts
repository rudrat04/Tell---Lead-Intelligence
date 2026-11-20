import { z } from "zod";

/**
 * A config pack: everything business-specific. The code is generic; a pack says who you sell to,
 * what need you solve, which signals mean what, and where to deliver. Packs are validated at startup.
 */

/** Regex written as a string; "(?i)" style inline flags allowed at the start. */
const pattern = z.string().min(1).refine((p) => {
  try { toRegex(p); return true; } catch { return false; }
}, "invalid regular expression");

export function toRegex(p: string): RegExp {
  const m = p.match(/^\(\?([a-z]+)\)(.*)$/s);
  return m ? new RegExp(m[2]!, m[1]) : new RegExp(p);
}

export const PackMetaSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  /** what you sell, one line; used in prompts and the digest */
  offer: z.string().min(10),
  operator: z.object({
    /** bot name for the User-Agent and robots.txt matching (letters, digits, dashes) */
    bot_name: z.string().regex(/^[A-Za-z0-9-]+$/),
    /** where site owners can learn about the bot (your site or the repo) */
    contact_url: z.string().url(),
  }),
  timezone: z.string().default("Asia/Kolkata"),
});

/**
 * A target buyer: the person to reach at an ICP company (buyers.yaml). The ICP (icp.yaml) describes companies; this
 * describes people: title, department, seniority, years of experience and how much they decide.
 */
export const BuyerSchema = z.object({
  title: z.string(),
  /** title patterns that count as this buyer */
  patterns: z.array(pattern).min(1),
  /** company size bands where this buyer is the right first contact (empty = any) */
  size_bands: z.array(z.string()).default([]),
  /** what to search for on LinkedIn when nobody with this title is known (defaults to the title) */
  search: z.string().optional(),
  /** department they sit in (shown in the digest; e.g. "Leadership", "Sales", "Marketing", "Revenue Operations") */
  department: z.string().optional(),
  seniority: z.enum(["founder", "c_level", "vp", "head", "manager", "individual"]).optional(),
  /** years of working experience, when people search shows a work history; unknown = never filtered out */
  years: z.object({ min: z.number().int().min(0).default(0), max: z.number().int().min(0).default(60) }).optional(),
  /** how much this person decides a purchase like yours: 1 = signs it, 0.5 = shapes it, 0.2 = uses it.
   *  Sets the "buyer" part of the score (with how sure the email is); never changes which companies need you. */
  decision_power: z.number().min(0).max(1).default(0.7),
});

export const IcpSchema = z.object({
  hard_filters: z.object({
    team_size: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
    industries_any: z.array(z.string()).min(1),
    statuses: z.array(z.string()).min(1),
    exclude_domains: z.array(z.string()).default([]),
    /** only accounts whose region is one of these (e.g. ["India"]); empty = any region. Unknown region fails, and person leads
     *  (no account, no region) are dropped while this is set. Applied when scoring, so existing accounts are filtered too. */
    regions_any: z.array(z.string()).default([]),
    /** sources other than YC rarely give team size / industry / status: "pass" admits them with a neutral fit score */
    unknown_facts: z.enum(["pass", "fail"]).default("fail"),
    /** per-segment exceptions to team_size and regions_any (niche segments: e.g. pharma up to 2,000 people, govcon in the
     *  US). An account whose segment is listed is checked against these instead; unlisted keys fall back to the defaults. */
    segment_overrides: z.record(z.string(), z.object({
      team_size: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
      regions_any: z.array(z.string()).optional(),
    })).default({}),
  }),
  size_bands: z.array(z.object({ band: z.string(), max: z.number().int() })).min(1),
  /** source industry label (e.g. YC "B2B", "Consumer") -> your segment name */
  segment_map: z.record(z.string(), z.string()).default({ B2B: "b2b" }),
  /** segment name -> what a company in it does. When set, a company whose segment no source gave is classified from
   *  its description (Exa company index) into one of these; a segment not reached from industries_any is out of ICP. */
  segment_descriptions: z.record(z.string(), z.string()).default({}),
  /** soft fit (0..1 per factor, weights sum to 1) */
  soft_fit: z.object({
    weights: z.record(z.string(), z.number().min(0)),
    size_band: z.record(z.string(), z.number().min(0).max(1)).default({}),
    region: z.record(z.string(), z.number().min(0).max(1)).default({}),
    region_default: z.number().min(0).max(1).default(0.5),
    segment: z.record(z.string(), z.number().min(0).max(1)).default({}),
    segment_default: z.number().min(0).max(1).default(0.5),
    /** unused since the score became need + fit + timing + buyer points (signals.score); kept so old packs load */
    influence: z.number().min(0).max(1).default(1),
  }),
  /** ranking by whether you can actually reach the problem owner: multiplier on priority, applied to a pool of
   *  2x max_leads after contacts and emails are known. All 1 = off (default). */
  reach: z.object({
    no_contact: z.number().min(0).max(1).default(1),
    no_email: z.number().min(0).max(1).default(1),
    guessed_email: z.number().min(0).max(1).default(1),
    /** the contact isn't one of the personas the matched play names */
    off_persona: z.number().min(0).max(1).default(1),
    /** boost when you can reach them through people you know (pnpm network: a connection, a past client there); 1 = off */
    warm_path: z.number().min(1).max(3).default(1),
  }).default({ no_contact: 1, no_email: 1, guessed_email: 1, off_persona: 1, warm_path: 1 }),
  /** the buyers' calendar, for the "good time to message" label (never part of the score) */
  calendar: z.object({
    /** month their financial year starts (India: 4 = April; US: 1) */
    fiscal_year_start_month: z.number().int().min(1).max(12).default(1),
    /** the last N days of a quarter count as "closing" (busy) */
    quarter_end_days: z.number().int().min(0).max(31).default(10),
    /** quiet periods by month-day ("12-22" to "01-02" wraps the year); add festivals per year */
    quiet_periods: z.array(z.object({
      from: z.string().regex(/^\d{2}-\d{2}$/), to: z.string().regex(/^\d{2}-\d{2}$/), reason: z.string().min(1),
    })).default([]),
  }).default({ fiscal_year_start_month: 1, quarter_end_days: 10, quiet_periods: [] }),
  /** who to contact at a matching company, in order of preference. Prefer a separate `buyers.yaml` (`buyers:` list, same
   *  shape): the ICP says which companies, the buyers say which people. The loader moves buyers.yaml here. */
  personas: z.array(BuyerSchema).default([]),
});

/** Signal types the code emits; a pack must define each of them in signals.yaml. */
export const CODE_SIGNAL_TYPES = [
  "explicit_hire_request", "pain_post", // posts (Gate 3)
  "contract_role", "first_role", "core_role_open", "adjacent_role_open", "core_role_open_45d", "core_role_filled", // job boards
  "funding_raise", "product_launch", // YC company pages (news, launches)
  "cta_sales_led", "pricing_page_added", "gtm_tool_added", "stack_sprawl", // website + DNS watch
] as const;

export const SignalsSchema = z.object({
  base_rate: z.number().gt(0).lt(1),
  /** minimum Gate 3 strength for a post to count as a signal */
  min_post_strength: z.number().int().min(1).max(5).default(3),
  /** at most this many events of one type count toward intent (a hiring spree is one story) */
  max_events_per_type: z.number().int().min(1).default(3),
  /** each further event of the same type counts this much of the one before (a hiring spree is one story, not five) */
  repeat_dampening: z.number().gt(0).max(1).default(1),
  /**
   * The 0-100 lead score is the sum of four parts you can read on every lead (weights are points and sum to 100):
   *   need:   how strongly the signals say they need you now (log lift of intent over base_rate; `full_need_lift` x = all points)
   *   fit:    how well the company matches the ICP (icp.soft_fit)
   *   timing: how fresh the newest signal is (half-life 14 days; a state that is still true is fresh)
   *   buyer:  whether you can reach someone who decides (buyers.yaml decision_power x email confidence); half points until
   *           contacts are looked up
   */
  score: z.object({
    need: z.number().min(0).default(50),
    fit: z.number().min(0).default(20),
    timing: z.number().min(0).default(15),
    buyer: z.number().min(0).default(15),
    full_need_lift: z.number().gt(1).default(25),
  }).default({ need: 50, fit: 20, timing: 15, buyer: 15, full_need_lift: 25 }),
  signals: z.record(z.string(), z.object({
    class: z.enum(["explicit", "implicit", "trigger", "pain", "negative"]),
    lr: z.number().gt(0),
    half_life_days: z.number().gt(0),
    strength: z.number().int().min(1).max(5).default(3),
    fast_lane: z.boolean().default(false),
    /** overrides max_events_per_type for this signal (e.g. 1: three founding roles are one "building GTM from zero" story) */
    max_events: z.number().int().min(1).optional(),
    /** a state that stays true while a source keeps seeing it (signals.last_seen_at), like the watch states: current while
     *  seen in the last 15 days (e.g. a drug still on the FDA shortage list) */
    state: z.boolean().optional(),
  })),
  gate1: z.object({
    required_any: z.array(pattern).default([]),
    never: z.array(pattern).default([]),
  }),
  /**
   * When an account may be delivered. One fresh signal of a class in `alone` is enough; otherwise it needs
   * `triggers_needed` independent fresh trigger events. Classes in `corroborate` must be backed by another signal
   * (Gate 5) before they count at all.
   */
  eligibility: z.object({
    alone: z.array(z.enum(["explicit", "implicit", "pain", "trigger"])).default(["explicit", "implicit"]),
    triggers_needed: z.number().int().min(1).default(2),
    corroborate: z.array(z.enum(["trigger", "pain"])).default(["trigger", "pain"]),
    fresh_days: z.number().int().min(1).default(30),
    /** a class in `alone` qualifies on its own only at this strength or above; weaker ones count like triggers
     *  (need `triggers_needed` independent fresh signals). 1 = every listed class qualifies alone. */
    alone_min_strength: z.number().int().min(1).max(5).default(1),
  }).default({ alone: ["explicit", "implicit"], triggers_needed: 2, corroborate: ["trigger", "pain"], fresh_days: 30, alone_min_strength: 1 }),
  /** Gate 2: similarity of new posts to good/bad examples (seeds here + your labelled posts). Shadow = log only. */
  gate2: z.object({
    mode: z.enum(["shadow", "enforce"]).default("shadow"),
    min_exemplars: z.number().int().min(1).default(20),
    drop_margin: z.number().min(0).max(1).default(0.15),
    drop_min_similarity: z.number().min(0).max(1).default(0.35),
    seeds: z.object({ pos: z.array(z.string()).default([]), neg: z.array(z.string()).default([]) }).default({ pos: [], neg: [] }),
  }).default({ mode: "shadow", min_exemplars: 20, drop_margin: 0.15, drop_min_similarity: 0.35, seeds: { pos: [], neg: [] } }),
});

export const PlaysSchema = z.object({
  /** true: an account with no matching play is never a lead (no play = no angle = nothing to say) */
  require_play: z.boolean().default(false),
  plays: z.record(z.string(), z.object({
    title: z.string(),
    /** all of these signal types within window_days */
    requires: z.array(z.string()).min(1),
    /** and at least one of these (e.g. any sign of new attention: launch, funding, new subdomain); empty = no extra condition */
    requires_any: z.array(z.string()).default([]),
    /** and none of these (current or within the window), e.g. "no RevOps hire yet" */
    absent: z.array(z.string()).default([]),
    window_days: z.number().int().min(1),
    angle: z.string(),
    /** at least this many events of a type (e.g. 3 sales roles open), checked with requires */
    min_count: z.record(z.string(), z.number().int().min(1)).default({}),
    /** a match makes the account eligible on its own (the combination is the need, e.g. sales hiring with no ops) */
    qualifies: z.boolean().default(false),
    /** persona titles (icp.personas) who own this problem, most fitting first; they're contacted before the default order */
    personas: z.array(z.string()).default([]),
    /** what you offer a lead in this play, when it differs from pack.yaml `offer` (niche plays: a buyer list, a teaming
     *  map). Replaces the general offer in the draft brief for leads whose strongest play sets it. */
    offer: z.string().optional(),
  })),
});

export const RolesSchema = z.object({
  /** the role you substitute for or bridge (open long = struggling to hire; removed fast = filled) */
  core: z.array(pattern).min(1),
  /** roles that show the need is forming */
  adjacent: z.array(pattern).default([]),
  /** titles that look similar but are not the need */
  exclude: z.array(pattern).default([]),
  contract: z.array(pattern).default(["(?i)\\b(contract(or)?|freelance|part[- ]time|temporary|temp|fractional|consultant)\\b"]),
  founding: z.array(pattern).default(["(?i)\\b(founding|first)\\b"]),
  /** phrases in a new GTM job ad that describe your offer's pain (jd_mentions, if the pack defines it) */
  jd_patterns: z.array(pattern).default([]),
  /** titles of leaders who hold a budget: one who started at an account in the last 90 days fires new_gtm_leader
   *  (seen in people-search results). Empty = the built-in GTM leader titles. */
  leaders: z.array(pattern).default([]),
  /**
   * Need check: role groups you substitute for, by plain title (e.g. "GTM": ["GTM Engineer", "Head of Growth"]). For
   * leads in the digest pool, one people search per account looks for anyone currently holding them. Nobody in a group
   * = `role_gap` (if signals.yaml defines it), shown as "Missing: X · has: Y"; a holder of a core role becomes a known
   * owner. Empty = off.
   */
  gaps: z.record(z.string(), z.array(z.string().min(2)).min(1)).default({}),
});

export const ExtractorSchema = z.object({
  /** what a genuine need for your offer looks like, for the classifier and verifier prompts */
  need_description: z.string().min(20),
  /** problem categories for posts ("other" is always added) */
  categories: z.array(z.string().regex(/^[a-z_]+$/)).min(1),
  /** what makes a post strength 5 */
  strength_5: z.string().min(10),
});

export const SourcesSchema = z.object({
  hn: z.object({ enabled: z.boolean().default(true), queries: z.array(z.string()).min(1) }),
  reddit: z.object({
    enabled: z.boolean().default(false),
    subs: z.array(z.string()).default([]),
    hiring_subs: z.array(z.string()).default([]),
  }).default({ enabled: false, subs: [], hiring_subs: [] }),
  yc: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  /** Web search (Serper, SERPER_API_KEY) for public posts asking for help, e.g. `site:linkedin.com/posts "looking for" hubspot`.
   *  Runs in the tick; `per_day` searches max (persisted), `per_tick` per tick; queries rotate across days. */
  web_search: z.object({
    enabled: z.boolean().default(false),
    queries: z.array(z.string()).default([]),
    per_day: z.number().int().min(1).max(100).default(8),
    per_tick: z.number().int().min(1).max(10).default(1),
    time_range: z.enum(["d", "w", "m"]).default("w"),
    /** Google country code for results */
    country: z.string().default("in"),
    /** several Google country codes, rotated per search (e.g. in, us, gb, ae, sg); empty = just `country` */
    countries: z.array(z.string()).default([]),
    /** results older than this (when the search shows a date) are dropped */
    max_age_days: z.number().int().min(1).default(14),
  }).default({ enabled: false, queries: [], per_day: 8, per_tick: 1, time_range: "w", country: "in", countries: [], max_age_days: 14 }),
  /** Funding news (Serper news API, headline + link + date only; articles are never fetched): companies named in "X
   *  raises ..." headlines become accounts once a company search proves their website, with a funding_raise signal. */
  funding_news: z.object({
    enabled: z.boolean().default(false),
    queries: z.array(z.string()).default([]),
    /** Google country code (in = India) and how far back: d / w / m */
    country: z.string().default("in"),
    time_range: z.enum(["d", "w", "m"]).default("w"),
    /** headlines must match one of these (regex, case-insensitive) and none of `exclude` (whole words) */
    keywords: z.array(z.string()).default(["rais", "funding", "seed", "series [a-d]", "pre-series"]),
    exclude: z.array(z.string()).default(["roundup", "round-up", "weekly", "this week", "funding wrap", "fund", "first close", "startups raised", "startups raise"]),
    /** news searches per day (Serper, usage_daily "serper_news"; the queries rotate across days) */
    per_day: z.number().int().min(1).max(50).default(3),
    /** company searches per run for new names (Exa, ~$0.007 each) */
    per_run: z.number().int().min(1).max(100).default(20),
  }).default({ enabled: false, queries: [], country: "in", time_range: "w", keywords: ["rais", "funding", "seed", "series [a-d]", "pre-series"], exclude: ["roundup", "round-up", "weekly", "this week", "funding wrap", "fund", "first close", "startups raised", "startups raise"], per_day: 3, per_run: 20 }),
  /** Workable job search: companies hiring these roles in `location` (or each of `locations`) become accounts + boards.
   *  Weekly runs every query x location; the daily discovery slice runs a rotating few (new companies every day). */
  workable: z.object({
    enabled: z.boolean().default(false),
    location: z.string().default("India"),
    /** several search locations (e.g. India, United Kingdom, Dubai); empty = just `location` */
    locations: z.array(z.string()).default([]),
    queries: z.array(z.string()).default([]),
    day_range: z.number().int().min(1).max(90).default(30),
    max_pages: z.number().int().min(1).max(10).default(5),
    /** companies checked per run (each costs a few requests) */
    max_companies: z.number().int().min(1).default(150),
  }).default({ enabled: false, location: "India", locations: [], queries: [], day_range: 30, max_pages: 5, max_companies: 150 }),
  /** JSearch (JSEARCH_API_KEY = OpenWeb Ninja, else RAPIDAPI_KEY; Google for Jobs: LinkedIn, Naukri, Indeed listings), daily: companies hiring the
   *  pack's roles become accounts, their roles tracked as state. Free Basic plan = 200 requests/month. */
  jsearch: z.object({
    enabled: z.boolean().default(false),
    queries: z.array(z.string()).default([]),
    location: z.string().default("India"),
    country: z.string().default("in"),
    /** several search places, rotated with the queries (each query x place in turn); empty = `location` + `country` */
    locations: z.array(z.object({ location: z.string(), country: z.string() })).default([]),
    date_posted: z.enum(["today", "3days", "week", "month"]).default("week"),
    /** requests per daily run, and per calendar month (persisted, counted before each request; paced over the month) */
    per_run: z.number().int().min(1).max(50).default(6),
    per_month: z.number().int().min(1).default(180),
    /** roles found only through JSearch close when no search has seen them for this long */
    close_after_days: z.number().int().min(7).default(21),
  }).default({ enabled: false, queries: [], location: "India", country: "in", locations: [], date_posted: "week", per_run: 6, per_month: 180, close_after_days: 21 }),
  /** Public-record sources for niche industries (pnpm niche). Each record names a company; the company becomes an
   *  account only when a company search proves its website (as funding news), and the signal quotes the record. */
  niche: z.object({
    /** company searches per source per run for new names (Exa, ~$0.007 each; usage_daily "exa_niche") */
    per_run: z.number().int().min(1).max(200).default(25),
    /** openFDA (no key needed; OPENFDA_API_KEY raises the daily limit): drugs on the FDA shortage list x the companies
     *  holding approved ANDAs for them. Holders HQ'd in `regions` become accounts (segment `segment`). */
    fda_shortage: z.object({
      enabled: z.boolean().default(false),
      regions: z.array(z.string()).default(["India"]),
      segment: z.string().default("pharma"),
      /** shortage records with this availability are not a shortage (FDA keeps resolved packages listed) */
      skip_availability: z.array(z.string()).default(["Available"]),
      max_substances: z.number().int().min(1).max(500).default(150),
    }).default({ enabled: false, regions: ["India"], segment: "pharma", skip_availability: ["Available"], max_substances: 150 }),
    /** USASpending (no key): federal contracts in these NAICS codes and set-asides ending `min_days`-`max_days` from now.
     *  The incumbent becomes an account (segment `segment`) with a contract_expiring signal. */
    usaspending: z.object({
      enabled: z.boolean().default(false),
      naics: z.array(z.string().regex(/^\d{2,6}$/)).default([]),
      /** USASpending set-aside codes, e.g. 8A, 8AN, SDVOSBC, SDVOSBS, WOSB, EDWOSB, HZC, SBA; empty = any */
      set_asides: z.array(z.string()).default([]),
      min_days: z.number().int().min(0).default(60),
      max_days: z.number().int().min(30).default(365),
      min_amount: z.number().min(0).default(500_000),
      /** result pages (100 awards each) per NAICS code per run */
      max_pages: z.number().int().min(1).max(50).default(10),
      segment: z.string().default("govcon"),
      region: z.string().default("United States of America"),
    }).default({ enabled: false, naics: [], set_asides: [], min_days: 60, max_days: 365, min_amount: 500_000, max_pages: 10, segment: "govcon", region: "United States of America" }),
    /** CMS Provider Data (no key): home health agencies and hospices Medicare-certified in the last `max_age_days`. Care
     *  Compare lists new providers about 8 months late, so a window under ~240 days finds nothing. */
    cms_new_providers: z.object({
      enabled: z.boolean().default(false),
      kinds: z.array(z.enum(["home_health", "hospice"])).default(["home_health", "hospice"]),
      /** two-letter state codes; empty = every state */
      states: z.array(z.string().length(2)).default([]),
      max_age_days: z.number().int().min(7).max(730).default(365),
      segment: z.string().default("home_health"),
      region: z.string().default("United States of America"),
    }).default({ enabled: false, kinds: ["home_health", "hospice"], states: [], max_age_days: 365, segment: "home_health", region: "United States of America" }),
  }).default({
    per_run: 25,
    fda_shortage: { enabled: false, regions: ["India"], segment: "pharma", skip_availability: ["Available"], max_substances: 150 },
    usaspending: { enabled: false, naics: [], set_asides: [], min_days: 60, max_days: 365, min_amount: 500_000, max_pages: 10, segment: "govcon", region: "United States of America" },
    cms_new_providers: { enabled: false, kinds: ["home_health", "hospice"], states: [], max_age_days: 365, segment: "home_health", region: "United States of America" },
  }),
  /** VC / accelerator portfolio pages (weekly): each company page's "Website" link becomes an account; job boards
   *  are found on that site. Region comes from job locations, never from the investor. */
  portfolios: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    index: z.string().url(),
    company_path: z.string().startsWith("/"),
    max_pages: z.number().int().min(1).max(50).default(20),
    /** the label text next to the company's own website link on a company page */
    website_labels: z.array(z.string()).default(["website", "visit website", "visit site"]),
  })).default([]),
});

export const DomainsSchema = z.object({
  never_company: z.array(z.string()).default([]),
  free_mail: z.array(z.string()).default([]),
  shorteners: z.array(z.string()).default([]),
});

/** GTM tools detected on a company's website scripts or DNS records (your own short list: what your offer touches). */
export const ToolsSchema = z.object({
  /** this many detected GTM tools = stack sprawl */
  sprawl_min: z.number().int().min(2).default(4),
  /** tool categories that don't count toward sprawl (e.g. ads: nearly every site has ad pixels) */
  sprawl_exclude_categories: z.array(z.string()).default([]),
  /** two or more tools in one of these categories = tool_overlap (e.g. two CRMs), if the pack defines that signal */
  overlap_categories: z.array(z.string()).default([]),
  /** tool categories that mean they send cold email (for email_auth_gap, if the pack defines it) */
  outbound_categories: z.array(z.string()).default(["outbound"]),
  /** tool categories that count as web analytics (site_health_poor says "no analytics tag" when none shows) */
  analytics_categories: z.array(z.string()).default(["analytics"]),
  tools: z.record(z.string().regex(/^[a-z0-9_]+$/), z.object({
    label: z.string(),
    category: z.string(),
    /** matched against script/link URLs and inline script text on the homepage */
    site: z.array(pattern).default([]),
    /** matched against TXT records (SPF includes, domain verification tokens) */
    dns: z.array(pattern).default([]),
  })).default({}),
});

/** Freelance / contract gigs that match the offer (a separate digest section; not account intent). */
export const GigsSchema = z.object({
  enabled: z.boolean().default(false),
  /** title or tags must match one of these (the work you sell) */
  match_any: z.array(pattern).default([]),
  /** titles that look similar but aren't your work */
  exclude: z.array(pattern).default([]),
  /** contract-ness: employment type, title or tags must match one of these */
  contract_any: z.array(pattern).default(["(?i)\\b(contract(or)?|freelance|part[- ]time|temporary|fractional|consultant|project[- ]based)\\b"]),
  /** location text that is open to you (empty/"worldwide" always passes) */
  locations_allowed: z.array(pattern).default(["(?i)\\b(worldwide|anywhere|global)\\b"]),
  max_age_days: z.number().int().min(1).default(14),
  max_in_digest: z.number().int().min(0).default(8),
  sources: z.object({
    remoteok: z.boolean().default(true),
    himalayas: z.boolean().default(true),
    yc: z.boolean().default(true),
    /** contract/freelance posts in HN "Who is hiring" */
    hn_hiring_thread: z.boolean().default(true),
  }).default({ remoteok: true, himalayas: true, yc: true, hn_hiring_thread: true }),
});

export const DeliverySchema = z.object({
  digest: z.object({
    to: z.string().email().optional(),
    /** the Gmail / Google Workspace address that sends (the authorised OAuth account) */
    from: z.string().email().optional(),
    from_name: z.string().default("Lead digest"),
    /** leads per digest; 0 = no cap: every lead over min_score that day (then min_score must be set) */
    max_leads: z.number().int().min(0).max(25).default(10),
    /** candidates scored, searched for contacts and checked for email = max_leads x this; leads with no named contact drop out
     *  and the next candidate takes the slot, so a larger pool fills the digest at the cost of more people searches */
    pool_multiplier: z.number().int().min(1).max(5).default(3),
    /** separate top-N lists by region, each ranked on score alone and shown under its own heading, e.g.
     *  [{ name: India, regions: [India], max_leads: 10 }, { name: Other regions, regions: [], max_leads: 10 }].
     *  `regions: []` = every region no other group names. Set = max_leads is ignored (the digest is their sum). */
    region_groups: z.array(z.object({
      name: z.string().min(1),
      regions: z.array(z.string()).default([]),
      max_leads: z.number().int().min(1).max(25),
      /** this list's score floor (0-100); unset = delivery.digest.min_score */
      min_score: z.number().int().min(0).max(100).optional(),
      /** accounts in these segments (icp segment names) go to this list whatever their region; a group with segments is
       *  filled first, so its accounts never appear in a region list too. Empty = region only. */
      segments: z.array(z.string()).optional(),
    })).default([]),
    /** slots kept for companies that qualify through non-hiring signals (funding, launches, tools, site changes, posts) */
    reserved_non_hiring: z.number().int().min(0).default(0),
    /** leads below this display score (0-100; 50 = twice as likely as an average account) never reach the email or the
     *  Sheet, fast lane included; the next lead above it takes the slot. 0 = off (rank only). */
    min_score: z.number().int().min(0).max(100).default(0),
    send_hour_local: z.number().int().min(0).max(23).default(9),
  }).default({ from_name: "Lead digest", max_leads: 10, region_groups: [], send_hour_local: 9, reserved_non_hiring: 0, pool_multiplier: 3, min_score: 0 }),
  redeliver_after_days: z.number().int().min(1).default(90),
  /** Google Sheet for leads + your labels (created by `pnpm sheet:setup`; private: it holds lead names) */
  sheet: z.object({ spreadsheet_id: z.string().min(10).optional() }).default({}),
  /** opening email drafted per lead (Sheet "Email draft" column): your next step and sign-off */
  email: z.object({
    /** the one next step every email ends on, e.g. "a free 30-minute GTM diagnostic call" */
    next_step: z.string().default("a short call"),
    /** appended under the body as written (name, site) */
    signature: z.string().default(""),
    max_words: z.number().int().min(40).max(200).default(110),
  }).default({ next_step: "a short call", signature: "", max_words: 110 }),
});

/** Code critic (plan 8f): drops leads that should never reach you. Every field optional so older packs still load. */
export const CriticSchema = z.object({
  /** a company selling what you sell (agency, outsourced SDRs, staffing): matched on name, domain and homepage title */
  vendor_patterns: z.array(pattern).default([]),
  /** tool keys (tools.yaml) whose presence means the problem is already solved */
  solved_tools: z.array(z.string()).default([]),
  /** negative signal types that mean "already solved" when newer than every positive signal */
  solved_types: z.array(z.string()).default(["core_role_filled"]),
  solved_max_age_days: z.number().int().min(1).default(60),
  /** Large companies whose size no source gave (Keka, Workable, JSearch accounts): proof of size from what we already see.
   *  url_patterns: a job/evidence URL on an enterprise careers system (Workday, SuccessFactors, a branded locale portal).
   *  title_patterns: the contact found for the account holds a regional / business-unit title. Unknown-size accounts only. */
  enterprise: z.object({
    url_patterns: z.array(pattern).default([]),
    title_patterns: z.array(pattern).default([]),
  }).default({ url_patterns: [], title_patterns: [] }),
});

/**
 * How the opening email is written (copy.yaml, optional): the copywriter brief the analyst follows, checked in code
 * where it can be (never_say, no durations). The plays' `angle` says what the need is; this says how to talk about it.
 */
export const CopySchema = z.object({
  /** voice and tone: who's writing, to whom, what good sounds like */
  voice: z.string().default(""),
  /** how to bring up what you noticed (e.g. lightly, as context, never as surveillance) */
  mention: z.string().default(""),
  /** offer framings to choose from and adapt; `plays` limits one to leads with those plays (empty = any lead) */
  offers: z.array(z.object({ plays: z.array(z.string()).default([]), idea: z.string().min(5) })).default([]),
  /** closing-question styles to vary between (the model writes its own in this spirit); empty = delivery.email.next_step */
  ctas: z.array(z.string().min(5)).default([]),
  /** phrases the email must never contain (case-insensitive); a draft that uses one is rewritten or dropped */
  never_say: z.array(z.string().min(2)).default([]),
  /** false: no "open 121 days" / "for months" in the email (default) */
  allow_durations: z.boolean().default(false),
  /** a few emails in the voice you want: patterns to learn from, never to copy */
  examples: z.array(z.object({ situation: z.string(), subject: z.string(), body: z.string() })).default([]),
  /** the first sentence of every email and LinkedIn message must match one of these (e.g. "saw|noticed"): no bare
   *  fragments the reader can't place. Empty = not checked. */
  opening_patterns: z.array(pattern).default([]),
  /** the greeting the code writes above every email ({first} = first name; without a contact the name part is dropped) */
  greeting: z.string().default("Hi {first},"),
  /** the first LinkedIn message after they accept your connection (not the connection note): Sheet "LinkedIn message" */
  linkedin: z.object({
    /** extra voice notes for LinkedIn (the email voice applies too) */
    voice: z.string().default(""),
    greeting: z.string().default("Hi {first},"),
    max_words: z.number().int().min(15).max(120).default(50),
    examples: z.array(z.object({ situation: z.string(), body: z.string() })).default([]),
  }).default({ voice: "", greeting: "Hi {first},", max_words: 50, examples: [] }),
});
export type Copy = z.infer<typeof CopySchema>;
const COPY_DEFAULT: Copy = { voice: "", mention: "", offers: [], ctas: [], never_say: [], allow_durations: false, examples: [], opening_patterns: [], greeting: "Hi {first},", linkedin: { voice: "", greeting: "Hi {first},", max_words: 50, examples: [] } };

export const PackSchema = z.object({
  meta: PackMetaSchema,
  icp: IcpSchema,
  signals: SignalsSchema,
  plays: PlaysSchema,
  roles: RolesSchema,
  extractor: ExtractorSchema,
  sources: SourcesSchema,
  domains: DomainsSchema,
  delivery: DeliverySchema,
  tools: ToolsSchema.default({ sprawl_min: 4, sprawl_exclude_categories: [], overlap_categories: [], outbound_categories: ["outbound"], analytics_categories: ["analytics"], tools: {} }),
  copy: CopySchema.default(COPY_DEFAULT),
  critic: CriticSchema.default({ vendor_patterns: [], solved_tools: [], solved_types: ["core_role_filled"], solved_max_age_days: 60, enterprise: { url_patterns: [], title_patterns: [] } }),
  gigs: GigsSchema.default({ enabled: false, match_any: [], exclude: [], contract_any: [], locations_allowed: [], max_age_days: 14, max_in_digest: 8, sources: { remoteok: true, himalayas: true, yc: true, hn_hiring_thread: true } }),
}).superRefine((p, ctx) => {
  for (const t of CODE_SIGNAL_TYPES) {
    if (!p.signals.signals[t]) ctx.addIssue({ code: "custom", path: ["signals", "signals", t], message: `signal type "${t}" is emitted by the code and must be defined` });
  }
  p.copy.offers.forEach((o, i) => o.plays.forEach((id) => {
    if (!p.plays.plays[id]) ctx.addIssue({ code: "custom", path: ["copy", "offers", i, "plays"], message: `unknown play "${id}"` });
  }));
  for (const [name, play] of Object.entries(p.plays.plays)) {
    for (const r of play.absent) {
      if (!p.signals.signals[r]) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "absent"], message: `unknown signal type "${r}"` });
    }
    for (const r of play.requires) {
      if (!p.signals.signals[r]) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "requires"], message: `unknown signal type "${r}"` });
    }
    for (const r of play.requires_any ?? []) {
      if (!p.signals.signals[r]) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "requires_any"], message: `unknown signal type "${r}"` });
    }
  }
  // cross-file names: a typo here never errors at run time, it just silently scores wrong (neutral fit, no persona)
  const personaTitles = new Set(p.icp.personas.map((x) => x.title));
  const bands = new Set(p.icp.size_bands.map((b) => b.band));
  for (const [name, play] of Object.entries(p.plays.plays)) {
    for (const t of play.personas) {
      if (!personaTitles.has(t)) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "personas"], message: `unknown buyer "${t}" (buyers.yaml titles: ${[...personaTitles].join(", ")})` });
    }
    for (const t of Object.keys(play.min_count)) {
      if (!play.requires.includes(t)) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "min_count"], message: `min_count "${t}" is not in requires` });
    }
  }
  p.icp.personas.forEach((x, i) => x.size_bands.forEach((b) => {
    if (!bands.has(b)) ctx.addIssue({ code: "custom", path: ["icp", "personas", i, "size_bands"], message: `unknown size band "${b}"` });
  }));
  for (const b of Object.keys(p.icp.soft_fit.size_band)) {
    if (!bands.has(b)) ctx.addIssue({ code: "custom", path: ["icp", "soft_fit", "size_band", b], message: `unknown size band "${b}"` });
  }
  const segments = new Set([...Object.values(p.icp.segment_map), ...Object.keys(p.icp.segment_descriptions)]);
  for (const sname of Object.keys(p.icp.soft_fit.segment)) {
    if (!segments.has(sname)) ctx.addIssue({ code: "custom", path: ["icp", "soft_fit", "segment", sname], message: `segment "${sname}" is never assigned (not in segment_map or segment_descriptions)` });
  }
  // a region you target but forgot to weigh gets region_default; only an issue when region carries weight
  if ((p.icp.soft_fit.weights.region ?? 0) > 0) for (const r of p.icp.hard_filters.regions_any) {
    if (p.icp.soft_fit.region[r] == null) ctx.addIssue({ code: "custom", path: ["icp", "soft_fit", "region"], message: `regions_any has "${r}" but soft_fit.region doesn't weigh it` });
  }
  const sw = p.signals.score;
  if (Math.abs(sw.need + sw.fit + sw.timing + sw.buyer - 100) > 0.01) ctx.addIssue({ code: "custom", path: ["signals", "score"], message: "need + fit + timing + buyer must sum to 100" });
  p.icp.personas.forEach((x, i) => { if (x.years && x.years.min > x.years.max) ctx.addIssue({ code: "custom", path: ["buyers", i, "years"], message: "min > max" }); });
  const w = Object.values(p.icp.soft_fit.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(w - 1) > 0.01) ctx.addIssue({ code: "custom", path: ["icp", "soft_fit", "weights"], message: `weights must sum to 1 (got ${w.toFixed(2)})` });
  const groups = p.delivery.digest.region_groups;
  if (groups.filter(isCatchAll).length > 1) ctx.addIssue({ code: "custom", path: ["delivery", "digest", "region_groups"], message: "only one group can be the catch-all (regions: [], no segments)" });
  const named = groups.flatMap((g) => g.regions);
  if (new Set(named).size !== named.length) ctx.addIssue({ code: "custom", path: ["delivery", "digest", "region_groups"], message: "a region is in two groups" });
  const anyRegions = [...p.icp.hard_filters.regions_any, ...Object.values(p.icp.hard_filters.segment_overrides).flatMap((o) => o.regions_any ?? [])];
  for (const r of named) if (p.icp.hard_filters.regions_any.length && !anyRegions.includes(r)) ctx.addIssue({ code: "custom", path: ["delivery", "digest", "region_groups"], message: `region "${r}" is not in icp.hard_filters.regions_any (it would never have leads)` });
  if (p.delivery.digest.max_leads === 0 && !groups.length && p.delivery.digest.min_score < 1) ctx.addIssue({ code: "custom", path: ["delivery", "digest", "min_score"], message: "max_leads 0 (no cap) needs a min_score, or every eligible account becomes a lead" });
  if (p.icp.hard_filters.team_size.min > p.icp.hard_filters.team_size.max) ctx.addIssue({ code: "custom", path: ["icp", "hard_filters", "team_size"], message: "min > max" });
  // niche segments: every override, digest group segment and niche source segment must be a segment the ICP admits
  const admitted = new Set(p.icp.hard_filters.industries_any.map((x) => p.icp.segment_map[x]).filter(Boolean));
  const checkSeg = (sname: string, path: (string | number)[]) => {
    if (!admitted.has(sname)) ctx.addIssue({ code: "custom", path, message: `segment "${sname}" is not admitted by the ICP (map an industries_any label to it in segment_map)` });
  };
  for (const [sname, o] of Object.entries(p.icp.hard_filters.segment_overrides)) {
    checkSeg(sname, ["icp", "hard_filters", "segment_overrides", sname]);
    if (o.team_size && o.team_size.min > o.team_size.max) ctx.addIssue({ code: "custom", path: ["icp", "hard_filters", "segment_overrides", sname, "team_size"], message: "min > max" });
  }
  groups.forEach((g, i) => (g.segments ?? []).forEach((sname) => checkSeg(sname, ["delivery", "digest", "region_groups", i, "segments"])));
  const n = p.sources.niche;
  if (n.fda_shortage.enabled) checkSeg(n.fda_shortage.segment, ["sources", "niche", "fda_shortage", "segment"]);
  if (n.usaspending.enabled) checkSeg(n.usaspending.segment, ["sources", "niche", "usaspending", "segment"]);
  if (n.cms_new_providers.enabled) checkSeg(n.cms_new_providers.segment, ["sources", "niche", "cms_new_providers", "segment"]);
});

/** The catch-all digest list: no regions and no segments. */
const isCatchAll = (g: { regions: string[]; segments?: string[] }) => !g.regions.length && !(g.segments?.length);

export type Pack = z.infer<typeof PackSchema>;

/** The digest group an account falls in: a group naming its segment first, then the one naming its region, else the
 *  catch-all (regions: [], no segments); null = none. */
export function regionGroupFor(pack: Pick<Pack, "delivery">, region: string | null | undefined, segment?: string | null) {
  const g = pack.delivery.digest.region_groups;
  return (segment ? g.find((x) => x.segments?.includes(segment)) : undefined)
    ?? g.find((x) => region != null && !x.segments?.length && x.regions.includes(region)) ?? g.find(isCatchAll) ?? null;
}

/** The score floor for an account: its digest group's min_score, else delivery.digest.min_score. */
export function minScoreFor(pack: Pick<Pack, "delivery">, region: string | null | undefined, segment?: string | null): number {
  return regionGroupFor(pack, region, segment)?.min_score ?? pack.delivery.digest.min_score;
}

/** Leads per digest: the sum of region_groups when set, else `delivery.digest.max_leads` (0 = no cap). */
export function leadCap(pack: Pick<Pack, "delivery">): number {
  const g = pack.delivery.digest.region_groups;
  if (g.length) return g.reduce((n, x) => n + x.max_leads, 0);
  return pack.delivery.digest.max_leads === 0 ? Infinity : pack.delivery.digest.max_leads;
}
export const PACK_FILES = ["pack", "icp", "buyers", "signals", "plays", "roles", "extractor", "sources", "domains", "delivery", "gigs", "tools", "critic", "copy"] as const;
