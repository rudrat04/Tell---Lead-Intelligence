CREATE TABLE "fit_checks" (
	"account_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"verdict" text NOT NULL,
	"need" text,
	"proof" text,
	"proof_url" text,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fit_checks_account_id_event_key_pk" PRIMARY KEY("account_id","event_key")
);
--> statement-breakpoint
ALTER TABLE "fit_checks" ADD CONSTRAINT "fit_checks_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;