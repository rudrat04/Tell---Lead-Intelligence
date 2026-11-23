CREATE TABLE "need_trades" (
	"id" text PRIMARY KEY NOT NULL,
	"supplier" text NOT NULL,
	"industry" text NOT NULL,
	"region" text NOT NULL,
	"what" text NOT NULL,
	"events" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
