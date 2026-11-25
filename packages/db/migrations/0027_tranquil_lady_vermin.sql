CREATE TABLE "signal_contacts" (
	"entity_key" text PRIMARY KEY NOT NULL,
	"entity_name" text NOT NULL,
	"people" jsonb NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL
);
