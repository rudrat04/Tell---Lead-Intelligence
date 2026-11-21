CREATE TABLE "market_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"opportunity" text NOT NULL,
	"key" text NOT NULL,
	"entity_name" text NOT NULL,
	"entity_key" text,
	"owner" text,
	"quote" text NOT NULL,
	"url" text NOT NULL,
	"amount" real,
	"event_date" timestamp with time zone,
	"facts" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_matches" (
	"event_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"roster" text NOT NULL,
	"fit" real NOT NULL,
	"reasons" jsonb NOT NULL,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunity_matches_event_id_account_id_pk" PRIMARY KEY("event_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "roster_members" (
	"roster" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"account_id" uuid,
	"facts" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_members_roster_key_pk" PRIMARY KEY("roster","key")
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "context" jsonb;--> statement-breakpoint
ALTER TABLE "opportunity_matches" ADD CONSTRAINT "opportunity_matches_event_id_market_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."market_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity_matches" ADD CONSTRAINT "opportunity_matches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roster_members" ADD CONSTRAINT "roster_members_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "market_events_opportunity_key_uq" ON "market_events" USING btree ("opportunity","key");--> statement-breakpoint
CREATE INDEX "market_events_seen_idx" ON "market_events" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "opportunity_matches_account_idx" ON "opportunity_matches" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "roster_members_account_idx" ON "roster_members" USING btree ("account_id");