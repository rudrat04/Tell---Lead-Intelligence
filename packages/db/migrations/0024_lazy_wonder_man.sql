CREATE TABLE "event_checks" (
	"url" text PRIMARY KEY NOT NULL,
	"verdict" text NOT NULL,
	"stage" text,
	"where_region" text,
	"entity_industry" text,
	"entity_sells" text,
	"happened" text,
	"quote" text,
	"stage_quote" text,
	"needs" jsonb NOT NULL,
	"source" text NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
