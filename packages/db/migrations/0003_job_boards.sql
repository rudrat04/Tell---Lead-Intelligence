CREATE TABLE "company_seeds" (
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"domain" text,
	"fit_pass" boolean NOT NULL,
	"reason" text,
	"site_checked_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_seeds_source_source_id_pk" PRIMARY KEY("source","source_id")
);
--> statement-breakpoint
CREATE TABLE "job_boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"source" text NOT NULL,
	"slug" text NOT NULL,
	"proof_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"baseline_done" boolean DEFAULT false NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"employment_type" text,
	"family" text NOT NULL,
	"posted_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "job_boards" ADD CONSTRAINT "job_boards_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_board_id_job_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."job_boards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "job_boards_source_slug_uq" ON "job_boards" USING btree ("source","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_board_external_uq" ON "jobs" USING btree ("board_id","external_id");