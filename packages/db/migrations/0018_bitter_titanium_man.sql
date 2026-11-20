CREATE TABLE "built_plays" (
	"account_id" uuid NOT NULL,
	"evidence_key" text NOT NULL,
	"play" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "built_plays_account_id_evidence_key_pk" PRIMARY KEY("account_id","evidence_key")
);
--> statement-breakpoint
ALTER TABLE "built_plays" ADD CONSTRAINT "built_plays_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;