ALTER TABLE "people" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "profile_urls" jsonb;--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "fetched_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "people_account_name_source_uq" ON "people" USING btree ("account_id","full_name","source");