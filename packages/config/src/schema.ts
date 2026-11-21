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

/**
 * One industry you sell into (industries.yaml), everything about it in one place. The loader expands it into the ICP
 * fields scoring reads (segment_map, segment_descriptions, industries_any, segment_overrides, soft_fit.segment), and the
 * play builder reads the rest (buyers, offer, what an opportunity looks like) for accounts in it.
 */
export const IndustrySchema = z.object({
  /** the industry name as sources and the digest show it ("Pharma") */
  label: z.string().min(1),
  /** other source labels that mean the same industry (YC "Industrials") */
  aliases: z.array(z.string()).default([]),
  /** what a company in it does: Haiku classifies companies with no label by this */
  description: z.string().min(10),
  /** regions and team size for this industry (unset = the ICP defaults) */
  regions: z.array(z.string()).optional(),
  team_size: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }).optional(),
  /** soft fit 0..1 (how readily this industry buys from you) */
  fit: z.number().min(0).max(1).optional(),
  /** buyers.yaml titles, most fitting first, for leads in this industry */
  buyers: z.array(z.string()).default([]),
  /** what you offer this industry: the play builder's offer for leads in it */
  offer: z.string().optional(),
  /** what opportunities here often look like: context for the judge / builder, never a filter */
  hint: z.string().optional(),
  /** older name for `hint` */
  opportunity: z.string().optional(),
  /** the free list `pnpm freelist` builds for leads here: federal_buyers | anda_holders | hospitals | permits | recompetes |
   *  gtm (no list: the GTM review) | manual (you put it together) */
  list: z.enum(["federal_buyers", "anda_holders", "hospitals", "permits", "recompetes", "gtm", "manual"]).default("manual"),
  /** described so companies can be classified into it, but never admitted (consumer brands) */
  excluded: z.boolean().default(false),
  /** the signal types that count for a company in this industry: what shows a need you can make an offer on. Evidence of
   *  any other type is ignored for its companies (a permit says nothing to a SaaS company; a sales hire says little to
   *  a generic drug maker). Unset = every type counts. Negative signals always count. */
  signals: z.array(z.string()).optional(),
});

/** One thing you can actually deliver (capabilities.yaml). The judge composes each lead's offer from these: a free
 *  first step (often a list public data can build) and the paid work after it. */
export const CapabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string(),
  /** what the person receives, in plain words */
  deliver: z.string().min(10),
  /** given away as the first step */
  free: z.boolean().default(false),
  /** the pnpm freelist generator that builds it, when it's a list */
  list: z.enum(["federal_buyers", "anda_holders", "hospitals", "permits", "recompetes"]).optional(),
  /** when it fits (a hint for the judge) */
  good_for: z.string().default(""),
  /** only offered to companies in these industries (segment names); empty = any industry */
  industries: z.array(z.string()).default([]),
});
export const CapabilitiesSchema = z.object({ capabilities: z.array(CapabilitySchema).default([]) });

/**
 * Intelligence modules (modules.yaml): what a prospect's business would want watched in ITS market, reused across
 * prospects in an industry (and as the starting config when you build it for them). A module names a few changes; the
 * research step picks the ones that fit the prospect's business model, and each change is shown with live examples.
 */
export const ModuleChangeSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /** the change, in the words of someone in that business ("Your buyers are building new plants") */
  title: z.string().min(5),
  /** whose companies show it: the prospect's customers, its competitors (same industry and region), its channel
   *  (distributors, partners, primes) or the market (tenders, contracts, approvals anyone can act on) */
  whose: z.enum(["customers", "competitors", "channel", "market"]),
  signals: z.array(z.string()).min(1),
  /** where those companies are; customers: empty = the industries the research says pay them; channel / market need it */
  industries: z.array(z.string()).default([]),
  /** an example's quote must match this (e.g. "hospital|clinic|lab|beds": a new home-care NPI is not a hospital opening) */
  must: z.string().optional(),
  /** why it matters to them, plain */
  why: z.string().min(10),
  /** what their team does with it, plain */
  action: z.string().min(10),
});
export const ModuleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  /** "Manufacturing expansion intelligence" */
  title: z.string().min(5),
  /** the prospect industries it is offered to */
  industries: z.array(z.string()).min(1),
  changes: z.array(ModuleChangeSchema).min(2),
  /** what you'd build for them, plain, one sentence */
  offer: z.string().min(10),
});
export const ModulesSchema = z.object({ modules: z.array(ModuleSchema).default([]) });

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
  /** industries.yaml, keyed by segment name (already expanded into the fields above by the loader) */
  industries: z.record(z.string(), IndustrySchema).default({}),
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
    /** legacy: need from per-signal likelihood ratios, fit from icp.soft_fit. judged: an opportunity judgement per lead
     *  (specific + prize + deliverable -> need, urgent -> timing), fit = reply rate learned from your labels; accounts
     *  not judged yet keep their legacy score */
    mode: z.enum(["legacy", "judged"]).default("legacy"),
    need: z.number().min(0).default(50),
    fit: z.number().min(0).default(20),
    timing: z.number().min(0).default(15),
    buyer: z.number().min(0).default(15),
    full_need_lift: z.number().gt(1).default(25),
    /** judged mode: accounts judged per digest (Haiku, cached per evidence + prompt version), the share of each list kept
     *  for under-tested industries / plays (exploration), the labelled leads a bucket needs before its rate counts, and
     *  how hard rates shrink toward the average (pseudo-count) */
    judge: z.object({
      per_run: z.number().int().min(1).max(300).default(60),
      explore_share: z.number().min(0).max(0.5).default(0.2),
      min_bucket: z.number().int().min(1).default(5),
      shrink: z.number().min(0).default(10),
    }).default({ per_run: 60, explore_share: 0.2, min_bucket: 5, shrink: 10 }),
  }).default({ mode: "legacy", need: 50, fit: 20, timing: 15, buyer: 15, full_need_lift: 25, judge: { per_run: 60, explore_share: 0.2, min_bucket: 5, shrink: 10 } }),
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
  /** when no play matches: build one from the account's own evidence (Haiku, checked in code; cached per evidence).
   *  A built play that qualifies makes the lead; one that doesn't drops it. Fixed plays always win when they match. */
  build: z.object({
    enabled: z.boolean().default(false),
    /** plays built per digest (Haiku, ~$0.002 each, shares the Haiku daily cap) */
    per_run: z.number().int().min(1).max(100).default(25),
  }).optional(),
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
    /** the free list `pnpm freelist` builds for this play (unset = the industry's) */
    list: z.enum(["federal_buyers", "anda_holders", "hospitals", "permits", "recompetes", "gtm", "manual"]).optional(),
    /** only fires for companies in these industries (segment names): a play is an offer to one kind of company. Empty =
     *  any industry, including companies whose industry is unknown. A scoped play never fires on an unknown industry. */
    industries: z.array(z.string()).default([]),
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
    /** per-source lookups per run, where a source resolves well (e.g. { socrata_nyc_permits: 30, anda_approvals: 30 }) */
    per_run_by_source: z.record(z.string(), z.number().int().min(0).max(200)).default({}),
    /** Exa searches per IST day across every niche run (the tick drains the queue until this is spent) */
    daily_budget: z.number().int().min(1).max(5000).default(150),
    /** website lookup on Maps when the company index finds nothing: Google Places (GOOGLE_MAPS_API_KEY, 1,000 free a
     *  month for the website field) first, else Serper places (SERPER_API_KEY) */
    maps: z.object({
      enabled: z.boolean().default(true),
      google_per_month: z.number().int().min(0).max(10_000).default(600),
      serper_per_day: z.number().int().min(0).max(100).default(5),
    }).default({ enabled: true, google_per_month: 600, serper_per_day: 5 }),
    /** NPPES weekly file: organisations with a new NPI in these taxonomies (code -> segment) */
    nppes: z.object({
      enabled: z.boolean().default(false),
      taxonomies: z.record(z.string().regex(/^[0-9A-Z]{10}$/), z.object({ segment: z.string(), label: z.string() })).default({}),
      max_age_days: z.number().int().min(3).max(60).default(14),
    }).optional(),
    /** SAM.gov new entity registrations (SAM_API_KEY): primary NAICS prefix -> segment; India + US registrants */
    sam_entities: z.object({
      enabled: z.boolean().default(false),
      naics_prefixes: z.record(z.string().regex(/^\d{2,6}$/), z.string()).default({}),
      days: z.number().int().min(1).max(14).default(3),
      countries: z.record(z.string(), z.string()).default({ USA: "United States of America", IND: "India" }),
    }).optional(),
    /** openFDA recalls (Class I/II): other holders of the recalled molecule get competitor_recall */
    recalls: z.object({
      enabled: z.boolean().default(false),
      max_age_days: z.number().int().min(7).max(120).default(30),
      regions: z.array(z.string()).default(["India", "United States of America"]),
      segment: z.string().default("pharma"),
    }).optional(),
    /** India business-event headlines (Serper news): "X bags order", "X receives environmental clearance"... */
    news_events: z.array(z.object({
      id: z.string().regex(/^[a-z0-9_]+$/),
      queries: z.array(z.string()).min(1),
      /** the verb phrase after the company name, as a regex ("bags|wins|secures") */
      verbs: z.string(),
      /** the headline must also match this (e.g. "order|contract") */
      must: z.string().default(""),
      signal_type: z.string(),
      segment: z.string(),
      region: z.string().default("India"),
      country: z.string().default("in"),
      must_mention: z.string().optional(),
    })).default([]),
    /** Serper news searches per day for news_events (usage_daily "serper_news_events"; queries rotate) */
    news_per_day: z.number().int().min(0).max(50).default(4),
    /** USASpending contracts whose description matches these keywords (SBIR / STTR Phase II awards: deep-tech small
     *  businesses that must commercialize; Salesforce / HubSpot / CRM implementation contracts: the prime needs build
     *  capacity). One block per signal type; `exclude` drops descriptions such as license resales. */
    keyword_awards: z.array(z.object({
      id: z.string().regex(/^[a-z0-9_]+$/),
      enabled: z.boolean().default(true),
      keywords: z.array(z.string().min(3)).min(1),
      /** the description must match this (e.g. "phase ii"), when set */
      must: z.string().optional(),
      exclude: z.string().optional(),
      signal_type: z.string(),
      segment: z.string(),
      region: z.string().default("United States of America"),
      max_age_days: z.number().int().min(1).max(120).default(45),
      min_amount: z.number().min(0).default(100_000),
      max_pages: z.number().int().min(1).max(5).default(1),
    })).default([]),
    /** ClinicalTrials.gov: industry-sponsored interventional trials completed recently; the sponsor's segment comes from
     *  the intervention type (DRUG -> pharma, DEVICE -> medtech) */
    clinical_trials: z.object({
      enabled: z.boolean().default(false),
      max_age_days: z.number().int().min(7).max(180).default(45),
      regions: z.array(z.string()).default(["India", "United States of America"]),
      segments: z.record(z.string(), z.string()).default({ DRUG: "pharma", BIOLOGICAL: "pharma", DEVICE: "medtech", DIAGNOSTIC_TEST: "medtech" }),
      max_trials: z.number().int().min(10).max(1000).default(300),
    }).optional(),
    /** how names become websites besides Exa and Maps: Wikidata (free, established companies) and Google web results
     *  via Serper (SERPER_API_KEY, paid per search: `web_per_day` 0 = off) */
    resolvers: z.object({
      wikidata: z.boolean().default(true),
      web_per_day: z.number().int().min(0).max(5000).default(0),
    }).default({ wikidata: true, web_per_day: 0 }),
    /** signal types you bring in yourself (`pnpm niche import <csv>`, `pnpm niche dmf <csv>`: tenders, RERA, customs,
     *  DMFs): pack:map shows them as fed by your imports instead of warning that nothing writes them */
    imports: z.array(z.string()).default([]),
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
      naics: z.array(z.string().regex(/^(\d{2}|\d{4}|\d{6})$/, "USASpending takes 2, 4 or 6-digit NAICS codes")).default([]),
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
    /** openFDA 510(k) device clearances (substantially equivalent) by applicants in these countries (ISO2) */
    fda_510k: z.object({
      enabled: z.boolean().default(false),
      countries: z.array(z.string().length(2)).default(["IN", "US"]),
      regions: z.array(z.string()).default(["India", "United States of America"]),
      max_age_days: z.number().int().min(7).max(365).default(60),
      segment: z.string().default("medtech"),
    }).optional(),
    /** openFDA Drugs@FDA: original ANDA approvals in the last `max_age_days` (a launch needs US buyers) */
    anda_approvals: z.object({
      enabled: z.boolean().default(false),
      regions: z.array(z.string()).default(["India", "United States of America"]),
      max_age_days: z.number().int().min(7).max(365).default(60),
      segment: z.string().default("pharma"),
    }).optional(),
    /** USASpending: contracts signed in the last `max_age_days`, per NAICS group (the winner becomes an account) */
    usaspending_awards: z.object({
      enabled: z.boolean().default(false),
      groups: z.array(z.object({ naics: z.array(z.string().regex(/^(\d{2}|\d{4}|\d{6})$/, "USASpending takes 2, 4 or 6-digit NAICS codes")).min(1), segment: z.string(),
        /** this group's set-asides ([] = any contract); unset = the source's */
        set_asides: z.array(z.string()).optional(),
        /** awards above this go to large primes, not the small companies you sell to (unset = no ceiling) */
        max_amount: z.number().min(0).optional() })).default([]),
      set_asides: z.array(z.string()).default([]),
      max_age_days: z.number().int().min(1).max(120).default(30),
      min_amount: z.number().min(0).default(500_000),
      max_pages: z.number().int().min(1).max(10).default(2),
      region: z.string().default("United States of America"),
    }).optional(),
    /** SEC Form D filings (SEC_USER_AGENT with a contact email): issuers in these Form D industries (industryGroupType ->
     *  segment) become accounts with a form_d_raise signal. Pooled investment funds are never accounts. */
    form_d: z.object({
      enabled: z.boolean().default(false),
      days: z.number().int().min(1).max(14).default(3),
      max_filings: z.number().int().min(10).max(2000).default(400),
      industries: z.record(z.string(), z.string()).default({}),
      min_sold: z.number().min(0).default(0),
    }).optional(),
    /** Socrata open-data datasets (city building permits, FMCSA carrier census...): each row names a company; the
     *  quote is a template over the row's fields ({field}, {field|money}, {field|date}, {field|title}). `where` may use
     *  {since} (ISO date) and {since_ymd} (YYYYMMDD). */
    socrata: z.array(z.object({
      id: z.string().regex(/^[a-z0-9_]+$/),
      enabled: z.boolean().default(true),
      domain: z.string(),
      dataset: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/),
      where: z.string(),
      order: z.string().optional(),
      limit: z.number().int().min(1).max(5000).default(1000),
      max_age_days: z.number().int().min(1).max(365).default(30),
      /** the company: a field, or the first contact whose type matches (Chicago: contact_1_name / contact_1_type ...) */
      company_field: z.string().optional(),
      company_pairs: z.object({ name: z.string(), type: z.string(), match: z.string(), max: z.number().int().min(1).max(30).default(15) }).optional(),
      /** company names matching this are skipped (people, "OWNER", "SELF") */
      skip_company: z.string().default("^(owner|self|n/?a|none|homeowner)$"),
      key_field: z.string(),
      date_field: z.string(),
      quote: z.string(),
      /** evidence URL template; default = the row's own API URL */
      url: z.string().optional(),
      query: z.string().default("{company}"),
      /** Maps search when the company index finds nothing (default: query) */
      maps_query: z.string().optional(),
      /** small local businesses (new trucking companies): Maps before the company index */
      maps_first: z.boolean().default(false),
      /** the company's website or email from the row ("{email_address}": its domain, unless free mail) */
      website: z.string().optional(),
      /** a named person in the row ({name: "{company_officer_1|title}", role: "Company officer"}) */
      contact: z.object({ name: z.string(), role: z.string() }).optional(),
      must_mention: z.string().optional(),
      signal_type: z.string(),
      segment: z.string(),
      region: z.string().default("United States of America"),
    })).default([]),
  }).default({
    per_run: 25, per_run_by_source: {}, daily_budget: 150, maps: { enabled: true, google_per_month: 600, serper_per_day: 5 }, news_events: [], news_per_day: 4, imports: [], keyword_awards: [], resolvers: { wikidata: true, web_per_day: 0 },
    fda_shortage: { enabled: false, regions: ["India"], segment: "pharma", skip_availability: ["Available"], max_substances: 150 },
    usaspending: { enabled: false, naics: [], set_asides: [], min_days: 60, max_days: 365, min_amount: 500_000, max_pages: 10, segment: "govcon", region: "United States of America" },
    cms_new_providers: { enabled: false, kinds: ["home_health", "hospice"], states: [], max_age_days: 365, segment: "home_health", region: "United States of America" },
    socrata: [],
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
  /** tools that were shut down or are being retired: a site still running one gets `tool_sunset` (a migration they
   *  must do, or a tag measuring nothing). Only shutdowns you can cite: `url` is the vendor's announcement. */
  sunsets: z.array(z.object({
    tool: z.string(),
    /** when it stopped (or stops) working, as the vendor says it: "1 July 2023" */
    ended: z.string().min(4),
    url: z.string().url(),
    /** what it means for them, in a few words ("collects no data since then") */
    note: z.string().min(5),
  })).default([]),
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
  /** same-day alert email (every tick) for the strongest fresh signals at accounts with a named contact; the lead
   *  still arrives complete (draft, Sheet row) in the next digest */
  alerts: z.object({
    enabled: z.boolean().default(false),
    /** signal types that alert (strength 5 / fast lane are the usual picks) */
    types: z.array(z.string()).default([]),
    /** contract signals alert only at or above this value (the "$X.YM" in the quote) */
    min_contract_usd: z.number().min(0).default(5_000_000),
    max_per_day: z.number().int().min(1).max(20).default(3),
  }).optional(),
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
  /** voice per audience, by industry (segment name) or "default": a pharma BD head and a seed-stage founder don't read
   *  the same email. The lead's industry picks one; unset = `voice` alone. */
  voices: z.record(z.string(), z.string()).default({}),
  /** email shapes to rotate between (one per lead, picked by its domain), so a day's drafts don't share a template */
  shapes: z.array(z.string().min(10)).default([]),
  /** closing-question styles per audience (segment name or "default"); falls back to `ctas` */
  ctas_by_segment: z.record(z.string(), z.array(z.string().min(5))).default({}),
  /** what you do, said at the end of every email in plain words, a different way per play: `idea` is the thought,
   *  `variants` the ways to say it (one per lead, picked by its play; always reworded, never pasted), `by_play` a
   *  play's own way */
  pitch: z.object({
    idea: z.string().default(""),
    variants: z.array(z.string().min(10)).default([]),
    by_play: z.record(z.string(), z.string().min(10)).default({}),
  }).default({ idea: "", variants: [], by_play: {} }),
  /** words readers outside tech don't use: rejected in drafts for every industry not in `allow_segments` */
  plain_words: z.object({
    banned: z.array(z.string()).default([]),
    allow_segments: z.array(z.string()).default([]),
  }).default({ banned: [], allow_segments: [] }),
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
const COPY_DEFAULT: Copy = { voice: "", mention: "", offers: [], ctas: [], never_say: [], allow_durations: false, examples: [], opening_patterns: [], voices: {}, shapes: [], ctas_by_segment: {}, pitch: { idea: "", variants: [], by_play: {} }, plain_words: { banned: [], allow_segments: [] }, greeting: "Hi {first},", linkedin: { voice: "", greeting: "Hi {first},", max_words: 50, examples: [] } };

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
  tools: ToolsSchema.default({ sprawl_min: 4, sprawl_exclude_categories: [], overlap_categories: [], outbound_categories: ["outbound"], analytics_categories: ["analytics"], tools: {}, sunsets: [] }),
  copy: CopySchema.default(COPY_DEFAULT),
  critic: CriticSchema.default({ vendor_patterns: [], solved_tools: [], solved_types: ["core_role_filled"], solved_max_age_days: 60, enterprise: { url_patterns: [], title_patterns: [] } }),
  gigs: GigsSchema.default({ enabled: false, match_any: [], exclude: [], contract_any: [], locations_allowed: [], max_age_days: 14, max_in_digest: 8, sources: { remoteok: true, himalayas: true, yc: true, hn_hiring_thread: true } }),
  capabilities: CapabilitiesSchema.default({ capabilities: [] }),
  modules: ModulesSchema.default({ modules: [] }),
}).superRefine((p, ctx) => {
  p.modules.modules.forEach((m, i) => {
    for (const seg of m.industries) if (!p.icp.industries[seg]) ctx.addIssue({ code: "custom", path: ["modules", i, "industries"], message: `unknown industry "${seg}"` });
    const ids = m.changes.map((c) => c.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["modules", i, "changes"], message: "change ids must be unique in a module" });
    m.changes.forEach((c, j) => {
      for (const t of c.signals) if (!p.signals.signals[t]) ctx.addIssue({ code: "custom", path: ["modules", i, "changes", j, "signals"], message: `unknown signal type "${t}"` });
      for (const seg of c.industries) if (!p.icp.industries[seg]) ctx.addIssue({ code: "custom", path: ["modules", i, "changes", j, "industries"], message: `unknown industry "${seg}"` });
      if ((c.whose === "channel" || c.whose === "market") && !c.industries.length) ctx.addIssue({ code: "custom", path: ["modules", i, "changes", j, "industries"], message: `a ${c.whose} change needs industries (where those companies are)` });
    });
  });
  const capIds = p.capabilities.capabilities.map((c) => c.id);
  if (new Set(capIds).size !== capIds.length) ctx.addIssue({ code: "custom", path: ["capabilities"], message: "capability ids must be unique" });
  // industries wired end to end: a play or capability names real industries, an industry counts real signal types, and
  // a play scoped to an industry can fire on the signals that industry counts (or it is dead config)
  const inds = p.icp.industries;
  for (const [seg, ind] of Object.entries(inds)) for (const t of ind.signals ?? []) {
    if (!p.signals.signals[t]) ctx.addIssue({ code: "custom", path: ["industries", seg, "signals"], message: `unknown signal type "${t}"` });
  }
  for (const [name, play] of Object.entries(p.plays.plays)) for (const seg of play.industries) {
    const ind = inds[seg];
    if (!ind) { ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "industries"], message: `unknown industry "${seg}" (industries.yaml: ${Object.keys(inds).join(", ")})` }); continue; }
    if (ind.excluded) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "industries"], message: `industry "${seg}" is excluded (never admitted)` });
    const counted = ind.signals;
    if (!counted) continue;
    const missing = play.requires.filter((t) => !counted.includes(t));
    if (missing.length) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "requires"], message: `can never fire for "${seg}": it requires ${missing.join(", ")}, which "${seg}" doesn't count (industries.yaml ${seg}.signals)` });
    if (play.requires_any.length && !play.requires_any.some((t) => counted.includes(t))) ctx.addIssue({ code: "custom", path: ["plays", "plays", name, "requires_any"], message: `can never fire for "${seg}": none of ${play.requires_any.join(", ")} counts there` });
  }
  p.capabilities.capabilities.forEach((c, i) => c.industries.forEach((seg) => {
    if (!inds[seg]) ctx.addIssue({ code: "custom", path: ["capabilities", i, "industries"], message: `unknown industry "${seg}"` });
  }));
  if (p.signals.score.mode === "judged" && !p.capabilities.capabilities.some((c) => c.free)) ctx.addIssue({ code: "custom", path: ["capabilities"], message: "judged scoring needs capabilities.yaml with at least one free capability (the first step an offer gives)" });
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
  for (const [seg, ind] of Object.entries(p.icp.industries)) for (const t of ind.buyers) {
    if (!personaTitles.has(t)) ctx.addIssue({ code: "custom", path: ["industries", seg, "buyers"], message: `unknown buyer "${t}"` });
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
  if (n.fda_510k?.enabled) checkSeg(n.fda_510k.segment, ["sources", "niche", "fda_510k", "segment"]);
  if (n.anda_approvals?.enabled) checkSeg(n.anda_approvals.segment, ["sources", "niche", "anda_approvals", "segment"]);
  if (n.usaspending_awards?.enabled) n.usaspending_awards.groups.forEach((g, i) => checkSeg(g.segment, ["sources", "niche", "usaspending_awards", "groups", i, "segment"]));
  if (n.form_d?.enabled) for (const [ind, seg] of Object.entries(n.form_d.industries)) checkSeg(seg, ["sources", "niche", "form_d", "industries", ind]);
  p.tools.sunsets.forEach((x, i) => { if (!p.tools.tools[x.tool]) ctx.addIssue({ code: "custom", path: ["tools", "sunsets", i, "tool"], message: `unknown tool "${x.tool}" (tools.yaml tools)` }); });
  n.keyword_awards.forEach((k, i) => {
    if (!k.enabled) return;
    if (!p.signals.signals[k.signal_type]) ctx.addIssue({ code: "custom", path: ["sources", "niche", "keyword_awards", i, "signal_type"], message: `unknown signal type "${k.signal_type}"` });
    if (k.segment !== "auto") checkSeg(k.segment, ["sources", "niche", "keyword_awards", i, "segment"]);
  });
  if (n.clinical_trials?.enabled) for (const [t, seg] of Object.entries(n.clinical_trials.segments)) checkSeg(seg, ["sources", "niche", "clinical_trials", "segments", t]);
  n.imports.forEach((t, i) => { if (!p.signals.signals[t]) ctx.addIssue({ code: "custom", path: ["sources", "niche", "imports", i], message: `unknown signal type "${t}"` }); });
  n.socrata.forEach((x, i) => {
    if (!x.enabled) return;
    checkSeg(x.segment, ["sources", "niche", "socrata", i, "segment"]);
    if (!p.signals.signals[x.signal_type]) ctx.addIssue({ code: "custom", path: ["sources", "niche", "socrata", i, "signal_type"], message: `unknown signal type "${x.signal_type}"` });
    if (!x.company_field && !x.company_pairs) ctx.addIssue({ code: "custom", path: ["sources", "niche", "socrata", i], message: "needs company_field or company_pairs" });
  });
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
export const PACK_FILES = ["pack", "icp", "industries", "capabilities", "modules", "buyers", "signals", "plays", "roles", "extractor", "sources", "domains", "delivery", "gigs", "tools", "critic", "copy"] as const;
