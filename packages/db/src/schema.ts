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
  halfLifeDays: real("half_life_days").notNull(),
  eventClusterId: uuid("event_cluster_id").references(() => eventClusters.id),
}, (t) => [index("signals_account_idx").on(t.accountId, t.observedAt)]);

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
});

export const authorMappings = pgTable("author_mappings", {
  id: id(),
  platform: text("platform").notNull(),
  handle: text("handle").notNull(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  confidence: text("confidence").notNull(), // explicit|profile|cross-platform|hint
  evidenceUrl: text("evidence_url"),
});

export const playsMatched = pgTable("plays_matched", {
  id: id(),
  accountId: uuid("account_id").notNull().references(() => accounts.id),
  playId: text("play_id").notNull(),
  evidenceSignalIds: uuid("evidence_signal_ids").array().notNull(),
  matchedAt: ts("matched_at").notNull().defaultNow(),
});

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
});

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
});

export const emails = pgTable("emails", {
  id: id(),
  personId: uuid("person_id").notNull().references(() => people.id),
  address: text("address").notNull(),
  status: text("status").notNull(), // observed|likely|guessed|invalid
  source: text("source"),
  checkedAt: ts("checked_at"),
});

export const domainMail = pgTable("domain_mail", {
  domain: text("domain").primaryKey(),
  mxProvider: text("mx_provider"),
  pattern: text("pattern"),
  patternConfidence: real("pattern_confidence"),
  checkedAt: ts("checked_at"),
});

export const deliveries = pgTable("deliveries", {
  id: id(),
  accountId: uuid("account_id").references(() => accounts.id),
  personLeadId: uuid("person_lead_id").references(() => personLeads.id),
  deliveredAt: ts("delivered_at").notNull().defaultNow(),
  kind: text("kind").notNull(), // normal|fast|exploration|interleaved
  configVersion: text("config_version").notNull(),
});

export const labels = pgTable("labels", {
  id: id(),
  deliveryId: uuid("delivery_id").references(() => deliveries.id),
  label: text("label"), // good|bad
  reason: text("reason"),
  outcome: text("outcome"), // contacted|replied|meeting|won
  createdAt: ts("created_at").notNull().defaultNow(),
});

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
