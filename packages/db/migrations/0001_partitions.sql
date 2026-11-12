-- Monthly range partitioning for the three high-volume tables (plan section 12).
-- Tables are empty at this point, so drop and recreate as partitioned.
DROP TABLE "raw_items";
--> statement-breakpoint
DROP TABLE "candidates";
--> statement-breakpoint
DROP TABLE "scores";
--> statement-breakpoint
CREATE TABLE "raw_items" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"r2_key" text,
	"content_hash" text NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "fetched_at")
) PARTITION BY RANGE ("fetched_at");
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"extractor" text NOT NULL,
	"output" jsonb,
	"gate_results" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "scores" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"run_id" uuid,
	"config_version" text NOT NULL,
	"intent_p" real NOT NULL,
	"fit" real NOT NULL,
	"timing" real NOT NULL,
	"reach" real,
	"priority" real NOT NULL,
	"lane" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "created_at")
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
-- Called by the monthly job: SELECT create_month_partitions(2);  (creates this month + next N)
CREATE OR REPLACE FUNCTION create_month_partitions(months_ahead int DEFAULT 2) RETURNS void AS $$
DECLARE
  t text; m int; start_d date; end_d date;
BEGIN
  FOREACH t IN ARRAY ARRAY['raw_items','candidates','scores'] LOOP
    FOR m IN 0..months_ahead LOOP
      start_d := (date_trunc('month', now()) + make_interval(months => m))::date;
      end_d := (start_d + interval '1 month')::date;
      EXECUTE format('CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        t || '_' || to_char(start_d, 'YYYY_MM'), t, start_d, end_d);
    END LOOP;
  END LOOP;
END $$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT create_month_partitions(2);
--> statement-breakpoint
CREATE INDEX "raw_items_source_ext_idx" ON "raw_items" ("source_id", "external_id");
