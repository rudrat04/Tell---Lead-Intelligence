ALTER TABLE "analyses" ADD COLUMN "evidence_key" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "opener" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "cited" jsonb;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "analyses" ADD COLUMN "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
CREATE UNIQUE INDEX "analyses_account_evidence_uq" ON "analyses" USING btree ("account_id","evidence_key");