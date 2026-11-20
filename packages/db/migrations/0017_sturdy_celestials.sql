CREATE TABLE "niche_queue" (
	"source" text NOT NULL,
	"key" text NOT NULL,
	"records" jsonb NOT NULL,
	"priority" real DEFAULT 0 NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "niche_queue_source_key_pk" PRIMARY KEY("source","key")
);
--> statement-breakpoint
CREATE INDEX "niche_queue_priority_idx" ON "niche_queue" USING btree ("priority","queued_at");