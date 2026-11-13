ALTER TABLE "domain_mail" ADD COLUMN "pattern_support" integer;--> statement-breakpoint
ALTER TABLE "domain_mail" ADD COLUMN "generic_address" text;--> statement-breakpoint
CREATE UNIQUE INDEX "emails_person_address_uq" ON "emails" USING btree ("person_id","address");