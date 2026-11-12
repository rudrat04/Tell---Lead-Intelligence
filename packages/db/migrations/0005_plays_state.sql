ALTER TABLE "plays_matched" ADD COLUMN "last_matched_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "plays_matched" ADD COLUMN "evidence" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "plays_matched_account_play_uq" ON "plays_matched" USING btree ("account_id","play_id");