CREATE TABLE "network_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"full_name" text NOT NULL,
	"company" text,
	"position" text,
	"profile_url" text,
	"connected_on" date,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone,
	"current_company" text,
	"current_title" text,
	"moved_at" timestamp with time zone,
	"move_url" text,
	"shown_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "people" ADD COLUMN "work_history" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "network_contacts_kind_name_company_uq" ON "network_contacts" USING btree ("kind","full_name","company");