CREATE TABLE "people_searches" (
	"account_id" uuid NOT NULL,
	"persona" text NOT NULL,
	"provider" text NOT NULL,
	"found" integer DEFAULT 0 NOT NULL,
	"searched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "people_searches_account_id_persona_provider_pk" PRIMARY KEY("account_id","persona","provider")
);
--> statement-breakpoint
ALTER TABLE "people_searches" ADD CONSTRAINT "people_searches_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;