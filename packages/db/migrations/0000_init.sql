CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"segment" text,
	"size_band" text,
	"region" text,
	"maturity_stage" text,
	"stage_changed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"evidence_status" text DEFAULT 'complete' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"hypothesis" text NOT NULL,
	"citations" uuid[] NOT NULL,
	"counter_evidence" text,
	"angle" text,
	"confidence" real,
	"critic_checks" jsonb
);
--> statement-breakpoint
CREATE TABLE "author_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"account_id" uuid NOT NULL,
	"confidence" text NOT NULL,
	"evidence_url" text
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"extractor" text NOT NULL,
	"output" jsonb,
	"gate_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidates_id_created_at_pk" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"git_sha" text NOT NULL,
	"status" text NOT NULL,
	"metrics" jsonb,
	"promoted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hashed_email" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"person_lead_id" uuid,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"config_version" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domain_mail" (
	"domain" text PRIMARY KEY NOT NULL,
	"mx_provider" text,
	"pattern" text,
	"pattern_confidence" real,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"address" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric" text NOT NULL,
	"value" real NOT NULL,
	"detail" jsonb,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"strongest_signal_id" uuid,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exemplars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(384),
	"signal_type" text NOT NULL,
	"label" text NOT NULL,
	"source_label_id" uuid
);
--> statement-breakpoint
CREATE TABLE "labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid,
	"label" text,
	"reason" text,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"full_name" text NOT NULL,
	"role" text,
	"source" text NOT NULL,
	"confidence" real
);
--> statement-breakpoint
CREATE TABLE "person_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"platform" text NOT NULL,
	"handle" text NOT NULL,
	"signal_id" uuid,
	"score" real,
	"mapped_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "plays_matched" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"play_id" text NOT NULL,
	"evidence_signal_ids" uuid[] NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"r2_key" text,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "raw_items_id_fetched_at_pk" PRIMARY KEY("id","fetched_at")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"yield_count" integer DEFAULT 0,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"config_version" text NOT NULL,
	"intent_p" real NOT NULL,
	"fit" real NOT NULL,
	"timing" real NOT NULL,
	"reach" real,
	"priority" real NOT NULL,
	"lane" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_id_created_at_pk" PRIMARY KEY("id","created_at")
);
--> statement-breakpoint
CREATE TABLE "seen_hashes" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_summaries" (
	"account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"count" integer NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_summaries_account_id_type_pk" PRIMARY KEY("account_id","type")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid,
	"class" text NOT NULL,
	"type" text NOT NULL,
	"strength" integer NOT NULL,
	"evidence_quote" text NOT NULL,
	"evidence_url" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"half_life_days" real NOT NULL,
	"event_cluster_id" uuid
);
--> statement-breakpoint
CREATE TABLE "snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"r2_key" text,
	"extracted" jsonb,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"healthy" boolean DEFAULT true NOT NULL,
	"fallback_active" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "suppression_list" (
	"hashed_email" text,
	"domain" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"config_version" text NOT NULL,
	"metrics" jsonb NOT NULL,
	"label_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tuning_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"snapshot_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"reason" text,
	"before" jsonb,
	"after" jsonb,
	"outcome_checked_at" timestamp with time zone,
	"helped" boolean
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"day" date NOT NULL,
	"service" text NOT NULL,
	"used" real NOT NULL,
	"limit" real NOT NULL,
	CONSTRAINT "usage_daily_day_service_pk" PRIMARY KEY("day","service")
);
--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "author_mappings" ADD CONSTRAINT "author_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_person_lead_id_person_leads_id_fk" FOREIGN KEY ("person_lead_id") REFERENCES "public"."person_leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_clusters" ADD CONSTRAINT "event_clusters_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "labels" ADD CONSTRAINT "labels_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_leads" ADD CONSTRAINT "person_leads_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_leads" ADD CONSTRAINT "person_leads_mapped_account_id_accounts_id_fk" FOREIGN KEY ("mapped_account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plays_matched" ADD CONSTRAINT "plays_matched_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_summaries" ADD CONSTRAINT "signal_summaries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_event_cluster_id_event_clusters_id_fk" FOREIGN KEY ("event_cluster_id") REFERENCES "public"."event_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "snapshots" ADD CONSTRAINT "snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tuning_actions" ADD CONSTRAINT "tuning_actions_snapshot_id_trend_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."trend_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signals_account_idx" ON "signals" USING btree ("account_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppression_unique" ON "suppression_list" USING btree ("hashed_email","domain");