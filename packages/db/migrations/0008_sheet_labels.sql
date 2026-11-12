ALTER TABLE "deliveries" ADD COLUMN "sheet_row" jsonb;--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "sheet_appended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "labels" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "labels_delivery_uq" ON "labels" USING btree ("delivery_id");