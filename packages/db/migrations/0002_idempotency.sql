CREATE UNIQUE INDEX "author_mappings_uq" ON "author_mappings" USING btree ("platform","handle","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_leads_platform_signal_uq" ON "person_leads" USING btree ("platform","signal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_evidence_type_uq" ON "signals" USING btree ("evidence_url","type");