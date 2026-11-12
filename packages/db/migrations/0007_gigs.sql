CREATE TABLE "gigs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"company" text,
	"company_domain" text,
	"url" text NOT NULL,
	"apply_url" text,
	"employment_type" text,
	"location" text,
	"tags" jsonb,
	"dedupe_key" text NOT NULL,
	"posted_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "gigs_source_external_uq" ON "gigs" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "gigs_dedupe_idx" ON "gigs" USING btree ("dedupe_key");