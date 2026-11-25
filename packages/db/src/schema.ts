import {
  pgTable, uuid, text, integer, real, boolean, timestamp, jsonb, date, primaryKey, index, uniqueIndex, customType,
} from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(384)", // bge-small
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => JSON.parse(v) as number[],
});

const id = () => uuid("id").primaryKey().defaultRandom();
const ts = (n: string) => timestamp(n, { withTimezone: true });

export const sources = pgTable("sources", {
  id: text("id").primaryKey(),
  kind: text("kind").notNull(),
  healthy: boolean("healthy").notNull().default(true),
  fallbackActive: boolean("fallback_active").notNull().default(false),
  lastRunAt: ts("last_run_at"),
});

export const runs = pgTable("runs", {
  id: id(),
  task: text("task").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  status: text("status").notNull(),
  yieldCount: integer("yield_count").default(0),
  error: text("error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
});

export const accounts = pgTable("accounts", {
  id: id(),
  domain: text("domain").notNull().unique(),
  name: text("name"),
  segment: text("segment"), // saas | agency
  sizeBand: text("size_band"),
  region: text("region"),
  /** what the company does, one or two sentences from its own company record (Exa), so plays, the judge and drafts
   *  know who they're talking to; a fact, not stored page text */
  description: text("description"),
  /** who buys from this company and which signals show those buyers need it (Haiku, from the description):
   *  { industries, signals, who, at } — the proof sample in drafts comes from accounts matching it */
  buyers: jsonb("buyers"),
  maturityStage: text("maturity_stage"),
  stageChangedAt: ts("stage_changed_at"),
  status: text("status").notNull().default("active"), // active|tombstone|archived
  evidenceStatus: text("evidence_status").notNull().default("complete"), // complete|incomplete
  createdAt: ts("created_at").notNull().defaultNow(),
});

// NOTE: raw_items / candidates / scores are partitioned monthly via raw SQL migration (see migrations/0001_partitions.sql)
export const rawItems = pgTable("raw_items", {
  id: uuid("id").notNull().defaultRandom(),
  sourceId: text("source_id").notNull(),
  externalId: text("external_id").notNull(),
  url: text("url"),
  r2Key: text("r2_key"),
  contentHash: text("content_hash").notNull(),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.id, t.fetchedAt] })]);

export const seenHashes = pgTable("seen_hashes", {
  contentHash: text("content_hash").primaryKey(),
  firstSeen: ts("first_seen").notNull().defaultNow(),
});

export const snapshots = pgTable("snapshots", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  kind: text("kind").notNull(),
  r2Key: text("r2_key"),
  extracted: jsonb("extracted"),
  takenAt: ts("taken_at").notNull().defaultNow(),
});

export const candidates = pgTable("candidates", {
  id: uuid("id").notNull().defaultRandom(),
  rawItemId: uuid("raw_item_id").notNull(),
  extractor: text("extractor").notNull(),
  output: jsonb("output"),
  gateResults: jsonb("gate_results"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] })]);

export const eventClusters = pgTable("event_clusters", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  type: text("type").notNull(),
  strongestSignalId: uuid("strongest_signal_id"),
  firstSeen: ts("first_seen").notNull(),
  lastSeen: ts("last_seen").notNull(),
});

export const signals = pgTable("signals", {
  id: id(),
  accountId: uuid("account_id").references(() => accounts.id),
  class: text("class").notNull(),
  type: text("type").notNull(),
  strength: integer("strength").notNull(),
  evidenceQuote: text("evidence_quote").notNull(),
  evidenceUrl: text("evidence_url").notNull(),
  observedAt: ts("observed_at").notNull(),
  /** states the weekly watch re-checks (tool overlap, stack sprawl, leaky capture, agency credit): last time still seen */
  lastSeenAt: ts("last_seen_at"),
  halfLifeDays: real("half_life_days").notNull(),
  eventClusterId: uuid("event_cluster_id").references(() => eventClusters.id),
}, (t) => [
  index("signals_account_idx").on(t.accountId, t.observedAt),
  // one signal per piece of evidence and type: re-runs and catch-up fetches can't inflate intent
  uniqueIndex("signals_evidence_type_uq").on(t.evidenceUrl, t.type),
]);

export const signalSummaries = pgTable("signal_summaries", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  type: text("type").notNull(),
  count: integer("count").notNull(),
  firstAt: ts("first_at").notNull(),
  lastAt: ts("last_at").notNull(),
}, (t) => [primaryKey({ columns: [t.accountId, t.type] })]);

export const personLeads = pgTable("person_leads", {
  id: id(),
  platform: text("platform").notNull(),
  handle: text("handle").notNull(),
  signalId: uuid("signal_id").references(() => signals.id),
  score: real("score"),
  mappedAccountId: uuid("mapped_account_id").references(() => accounts.id),
}, (t) => [uniqueIndex("person_leads_platform_signal_uq").on(t.platform, t.signalId)]);

export const authorMappings = pgTable("author_mappings", {
  id: id(),
  platform: text("platform").notNull(),
  handle: text("handle").notNull(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  confidence: text("confidence").notNull(), // explicit|profile|cross-platform|hint
  evidenceUrl: text("evidence_url"),
}, (t) => [uniqueIndex("author_mappings_uq").on(t.platform, t.handle, t.accountId)]);

export const playsMatched = pgTable("plays_matched", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  playId: text("play_id").notNull(),
  evidenceSignalIds: uuid("evidence_signal_ids").array().notNull(),
  /** first time this play fired for this account (a play first matched after a delivery = new reason to re-deliver) */
  matchedAt: ts("matched_at").notNull().defaultNow(),
  lastMatchedAt: ts("last_matched_at").notNull().defaultNow(),
  /** cited evidence: [{kind: job|signal, id, type, quote, url}] */
  evidence: jsonb("evidence"),
}, (t) => [uniqueIndex("plays_matched_account_play_uq").on(t.accountId, t.playId)]);

export const scores = pgTable("scores", {
  id: uuid("id").notNull().defaultRandom(),
  accountId: uuid("account_id").notNull(),
  runId: uuid("run_id"),
  configVersion: text("config_version").notNull(),
  intentP: real("intent_p").notNull(),
  fit: real("fit").notNull(),
  timing: real("timing").notNull(),
  reach: real("reach"),
  priority: real("priority").notNull(),
  lane: text("lane").notNull(), // combined|fast
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.id, t.createdAt] })]);

export const analyses = pgTable("analyses", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  hypothesis: text("hypothesis").notNull(),
  citations: uuid("citations").array().notNull(),
  counterEvidence: text("counter_evidence"),
  angle: text("angle"),
  confidence: real("confidence"),
  criticChecks: jsonb("critic_checks"),
  /** hash of the evidence refs the analysis was written from: same evidence, same analysis (no repeat spend) */
  evidenceKey: text("evidence_key"),
  opener: text("opener"),
  /** cited evidence as [{ kind: job|signal, id, url }] (citations uuid[] can't say which table) */
  cited: jsonb("cited"),
  model: text("model"),
  /** opening email drafted with the analysis (subject + body without greeting/signature) */
  emailSubject: text("email_subject"),
  emailBody: text("email_body"),
  /** first LinkedIn message after they accept (without the greeting the code writes) */
  linkedinMessage: text("linkedin_message"),
  createdAt: ts("created_at").defaultNow(),
}, (t) => [uniqueIndex("analyses_account_evidence_uq").on(t.accountId, t.evidenceKey)]);

export const exemplars = pgTable("exemplars", {
  id: id(),
  text: text("text").notNull(),
  embedding: vector("embedding"),
  signalType: text("signal_type").notNull(),
  label: text("label").notNull(), // pos|neg
  sourceLabelId: uuid("source_label_id"),
});

export const people = pgTable("people", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  fullName: text("full_name").notNull(),
  role: text("role"),
  source: text("source").notNull(),
  confidence: real("confidence"),
  /** where the name came from (provenance, plan section 9) */
  sourceUrl: text("source_url"),
  /** public profile links: { linkedin, twitter } */
  profileUrls: jsonb("profile_urls"),
  /** past roles from the people-search result [{ title, company, from, to }] (warm path: shared past employer) */
  workHistory: jsonb("work_history"),
  fetchedAt: ts("fetched_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("people_account_name_source_uq").on(t.accountId, t.fullName, t.source)]);

/**
 * The operator's own network, imported locally (`pnpm network`), never from a public source and never in the repo:
 *  - connection: their LinkedIn connections export (name, company, position, profile URL; no emails stored)
 *  - client: past clients / champions (watched for job moves: champion_moved)
 *  - employer: the operator's own past employers (shared-employer warm path)
 * Champion tracking: last company/title seen by people search, when they moved, when the digest showed it.
 */
export const networkContacts = pgTable("network_contacts", {
  id: id(),
  kind: text("kind").notNull(), // connection | client | employer
  fullName: text("full_name").notNull(),
  company: text("company"),
  position: text("position"),
  profileUrl: text("profile_url"),
  connectedOn: date("connected_on"),
  importedAt: ts("imported_at").notNull().defaultNow(),
  checkedAt: ts("checked_at"),
  currentCompany: text("current_company"),
  currentTitle: text("current_title"),
  movedAt: ts("moved_at"),
  moveUrl: text("move_url"),
  shownAt: ts("shown_at"),
}, (t) => [uniqueIndex("network_contacts_kind_name_company_uq").on(t.kind, t.fullName, t.company)]);

export const emails = pgTable("emails", {
  id: id(),
  personId: uuid("person_id").notNull().references(() => people.id),
  address: text("address").notNull(),
  status: text("status").notNull(), // observed|likely|guessed|invalid
  source: text("source"),
  checkedAt: ts("checked_at"),
}, (t) => [uniqueIndex("emails_person_address_uq").on(t.personId, t.address)]);

export const domainMail = pgTable("domain_mail", {
  domain: text("domain").primaryKey(),
  mxProvider: text("mx_provider"),
  pattern: text("pattern"),
  patternConfidence: real("pattern_confidence"),
  /** how many name-matched public addresses the pattern was learned from */
  patternSupport: integer("pattern_support"),
  /** best shared mailbox seen on the site (founders@, hello@), a fallback channel */
  genericAddress: text("generic_address"),
  checkedAt: ts("checked_at"),
});

export const deliveries = pgTable("deliveries", {
  id: id(),
  accountId: uuid("account_id").references(() => accounts.id),
  personLeadId: uuid("person_lead_id").references(() => personLeads.id),
  deliveredAt: ts("delivered_at").notNull().defaultNow(),
  kind: text("kind").notNull(), // normal|fast|exploration|interleaved
  configVersion: text("config_version").notNull(),
  /** the Google Sheet row written for this lead (kept so a failed append can be retried without resending) */
  sheetRow: jsonb("sheet_row"),
  sheetAppendedAt: ts("sheet_appended_at"),
  /** what an on-click draft needs (opportunity leads: the events, the angle, the contact), so the draft job writes from
   *  the same facts the lead showed */
  context: jsonb("context"),
});

export const labels = pgTable("labels", {
  id: id(),
  deliveryId: uuid("delivery_id").references(() => deliveries.id),
  label: text("label"), // good|bad
  reason: text("reason"),
  outcome: text("outcome"), // contacted|replied|meeting|won
  notes: text("notes"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("labels_delivery_uq").on(t.deliveryId)]);

export const suppressionList = pgTable("suppression_list", {
  hashedEmail: text("hashed_email"),
  domain: text("domain"),
  addedAt: ts("added_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("suppression_unique").on(t.hashedEmail, t.domain)]);

export const deletionRequests = pgTable("deletion_requests", {
  id: id(),
  hashedEmail: text("hashed_email").notNull(),
  requestedAt: ts("requested_at").notNull().defaultNow(),
  completedAt: ts("completed_at"),
});

export const configVersions = pgTable("config_versions", {
  id: id(),
  gitSha: text("git_sha").notNull(),
  status: text("status").notNull(), // champion|challenger|retired
  metrics: jsonb("metrics"),
  promotedAt: ts("promoted_at"),
});

export const trendSnapshots = pgTable("trend_snapshots", {
  id: id(),
  period: text("period").notNull(), // week|month
  periodStart: date("period_start").notNull(),
  configVersion: text("config_version").notNull(),
  metrics: jsonb("metrics").notNull(),
  labelCount: integer("label_count").notNull(),
});

export const tuningActions = pgTable("tuning_actions", {
  id: id(),
  snapshotId: uuid("snapshot_id").references(() => trendSnapshots.id),
  action: text("action").notNull(),
  target: text("target").notNull(),
  reason: text("reason"),
  before: jsonb("before"),
  after: jsonb("after"),
  outcomeCheckedAt: ts("outcome_checked_at"),
  helped: boolean("helped"),
  /** proposed | applied | rejected (proposals are never applied automatically) */
  status: text("status").notNull().default("proposed"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const evalResults = pgTable("eval_results", {
  id: id(),
  metric: text("metric").notNull(),
  value: real("value").notNull(),
  detail: jsonb("detail"),
  computedAt: ts("computed_at").notNull().defaultNow(),
});

export const usageDaily = pgTable("usage_daily", {
  day: date("day").notNull(),
  service: text("service").notNull(),
  used: real("used").notNull(),
  limit: real("limit").notNull(),
}, (t) => [primaryKey({ columns: [t.day, t.service] })]);

/** Job boards tracked per account (plan 5b careers watch). source: yc | greenhouse | lever | ashby */
export const jobBoards = pgTable("job_boards", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  source: text("source").notNull(),
  slug: text("slug").notNull(),
  /** where ownership was proven: the company's own page that links the board, or the YC directory */
  proofUrl: text("proof_url").notNull(),
  status: text("status").notNull().default("active"), // active | dead | staffing (a recruiter's board)
  baselineDone: boolean("baseline_done").notNull().default(false),
  failCount: integer("fail_count").notNull().default(0),
  lastCheckedAt: ts("last_checked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("job_boards_source_slug_uq").on(t.source, t.slug)]);

/** GTM/ops roles seen on tracked boards; the daily diff of this table produces job signals. */
export const jobs = pgTable("jobs", {
  id: id(),
  boardId: uuid("board_id").notNull().references(() => jobBoards.id),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  employmentType: text("employment_type"),
  family: text("family").notNull(), // ops | gtm
  postedAt: ts("posted_at"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
  closedAt: ts("closed_at"),
}, (t) => [uniqueIndex("jobs_board_external_uq").on(t.boardId, t.externalId)]);

/** Companies evaluated against the ICP hard filters; tombstoned ones are never re-processed (plan 12). */
export const companySeeds = pgTable("company_seeds", {
  source: text("source").notNull(), // yc
  sourceId: text("source_id").notNull(),
  domain: text("domain"),
  fitPass: boolean("fit_pass").notNull(),
  reason: text("reason"),
  siteCheckedAt: ts("site_checked_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.source, t.sourceId] })]);

/** Freelance/contract gigs matching the offer (kept apart from account intent; each delivered once). */
export const gigs = pgTable("gigs", {
  id: id(),
  source: text("source").notNull(), // remoteok | himalayas | yc
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  company: text("company"),
  companyDomain: text("company_domain"),
  /** the source's page for the gig (attribution link) */
  url: text("url").notNull(),
  /** where to apply (Himalayas terms: must be the API's applicationLink) */
  applyUrl: text("apply_url"),
  employmentType: text("employment_type"),
  location: text("location"),
  tags: jsonb("tags"),
  /** normalised company + title, to collapse the same gig posted on several boards */
  dedupeKey: text("dedupe_key").notNull(),
  postedAt: ts("posted_at"),
  expiresAt: ts("expires_at"),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  deliveredAt: ts("delivered_at"),
}, (t) => [
  uniqueIndex("gigs_source_external_uq").on(t.source, t.externalId),
  index("gigs_dedupe_idx").on(t.dedupeKey),
]);

/** People searches already made (per account + persona), so the same search isn't repeated within the cache window. */
export const peopleSearches = pgTable("people_searches", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  persona: text("persona").notNull(),
  provider: text("provider").notNull(),
  found: integer("found").notNull().default(0),
  searchedAt: ts("searched_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.persona, t.provider] })]);

/** Niche public records waiting for a company lookup (over the per-run search cap): drained a few at a time by
 *  `pnpm niche drain` in every tick, within the daily search budget. Records are public facts (quote + URL). */
export const nicheQueue = pgTable("niche_queue", {
  source: text("source").notNull(),
  /** company key (one lookup per name per source) */
  key: text("key").notNull(),
  /** NicheRecord[] for that company, JSON (dates as ISO strings, mustMention as a regex source) */
  records: jsonb("records").notNull(),
  /** higher first (a strength-5 signal before a strength-3 one, then the largest amounts) */
  priority: real("priority").notNull().default(0),
  queuedAt: ts("queued_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.source, t.key] }), index("niche_queue_priority_idx").on(t.priority, t.queuedAt)]);

/** Plays built from an account's own evidence when no pack play matched (plays.build). Keyed by the evidence, so a
 *  play is rebuilt only when the evidence changes. `play` is null when the builder found no need (no lead). */
export const builtPlays = pgTable("built_plays", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  evidenceKey: text("evidence_key").notNull(),
  play: jsonb("play"),
  reason: text("reason"),
  createdAt: ts("created_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.evidenceKey] })]);

/**
 * Opportunities (pack opportunities.yaml): an event is an opportunity for OTHER companies. The company behind the event
 * (signal entity, e.g. the incumbent of an expiring contract) is stored by name only: it is never the prospect.
 * Events are public facts (quote + URL + counted facts), keyed per opportunity so re-runs refresh, never duplicate.
 */
export const marketEvents = pgTable("market_events", {
  id: id(),
  /** pack opportunity id (opportunities.yaml) */
  opportunity: text("opportunity").notNull(),
  /** the record's own id (USASpending award id) */
  key: text("key").notNull(),
  /** who the event is about (the incumbent): excluded from its own event */
  entityName: text("entity_name").notNull(),
  entityKey: text("entity_key"),
  /** who controls the opportunity (the awarding agency) */
  owner: text("owner"),
  quote: text("quote").notNull(),
  url: text("url").notNull(),
  amount: real("amount"),
  /** the date the opportunity turns on (contract end date) */
  eventDate: ts("event_date"),
  /** counted facts for matching and drafts: { naics, agency, subAgency, setAside, state, psc, uei, description } */
  facts: jsonb("facts").notNull(),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
}, (t) => [uniqueIndex("market_events_opportunity_key_uq").on(t.opportunity, t.key), index("market_events_seen_idx").on(t.lastSeenAt)]);

/** Companies that can benefit from a kind of event, each proven by its own record (past awards). `accountId` is set
 *  once the name resolves to a website (the niche resolvers); until then the member waits. */
export const rosterMembers = pgTable("roster_members", {
  roster: text("roster").notNull(),
  /** company key (companyKey of the name), the same key the niche resolvers seed under */
  key: text("key").notNull(),
  name: text("name").notNull(),
  accountId: uuid("account_id").references(() => accounts.id),
  /** { naics[], agencies[], subAgencies[], setAsides[], awards, total, largest, lastAwardAt, ueis[], evidence: [{quote, url}] } */
  facts: jsonb("facts").notNull(),
  /** pending (not looked up yet) | resolved | miss */
  status: text("status").notNull().default("pending"),
  /** how much the record weighs (awards x amount), lookups go in this order */
  priority: real("priority").notNull().default(0),
  refreshedAt: ts("refreshed_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.roster, t.key] }), index("roster_members_account_idx").on(t.accountId)]);

/** One event matched to one beneficiary, with why (computed in code, pure: intel/opportunity.ts). */
export const opportunityMatches = pgTable("opportunity_matches", {
  eventId: uuid("event_id").notNull().references(() => marketEvents.id, { onDelete: "cascade" }),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  roster: text("roster").notNull(),
  /** 0-1 */
  fit: real("fit").notNull(),
  reasons: jsonb("reasons").notNull(),
  matchedAt: ts("matched_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.eventId, t.accountId] }), index("opportunity_matches_account_idx").on(t.accountId)]);

/** Proof checks (opportunities): does this beneficiary's own website show it can serve what the event needs? One row
 *  per account + event, re-checked after FIT_CHECK_DAYS. `proof` is one sentence copied from its site (a fact). */
export const fitChecks = pgTable("fit_checks", {
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  eventKey: text("event_key").notNull(),
  verdict: text("verdict").notNull(), // yes | no | unclear
  need: text("need"),
  proof: text("proof"),
  proofUrl: text("proof_url"),
  reason: text("reason"),
  checkedAt: ts("checked_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.accountId, t.eventKey] })]);

/** A trade: the kind of company a verified need asks for ("beverage filling line maker", India), searched for and
 *  matched like a roster (pipeline/trades.ts). Kept while needs keep naming it. */
export const needTrades = pgTable("need_trades", {
  id: text("id").primaryKey(), // trade:<hash of industry | region | normalised supplier>
  supplier: text("supplier").notNull(),
  industry: text("industry").notNull(),
  region: text("region").notNull(),
  /** one need that named it (shown on the lead's opportunity line) */
  what: text("what").notNull(),
  events: integer("events").notNull().default(1),
  firstSeenAt: ts("first_seen_at").notNull().defaultNow(),
  lastSeenAt: ts("last_seen_at").notNull().defaultNow(),
});

/** People at the company behind a signal who handle what it must buy (procurement, projects, tenders), found once per
 *  company name by people search (pipeline/signal-contacts.ts) and re-searched after opportunities.signal_contacts.refresh_days.
 *  Names, titles and profile links only: no email is ever guessed for them. */
export const signalContacts = pgTable("signal_contacts", {
  entityKey: text("entity_key").primaryKey(),
  entityName: text("entity_name").notNull(),
  /** [{ name, role, linkedin }] */
  people: jsonb("people").notNull(),
  searchedAt: ts("searched_at").notNull().defaultNow(),
});

/** Fact-check of one market event (by its article / record URL), done once: what happened, the stage, where the work
 *  is, and what it must buy from other companies, every part quoted from the text (extract/event-check.ts). */
export const eventChecks = pgTable("event_checks", {
  url: text("url").primaryKey(),
  verdict: text("verdict").notNull(), // ok | none | unclear
  stage: text("stage"), // early | committed | buying
  where: text("where_region"),
  entityIndustry: text("entity_industry"),
  entitySells: text("entity_sells"),
  happened: text("happened"),
  quote: text("quote"),
  stageQuote: text("stage_quote"),
  /** [{ what, supplier, industry, quote }] */
  needs: jsonb("needs").notNull(),
  source: text("source").notNull(), // article | headline
  reason: text("reason"),
  /** EVENT_CHECK_VERSION it was made with (an older one is checked again) */
  version: integer("version").notNull().default(1),
  checkedAt: ts("checked_at").notNull().defaultNow(),
});
