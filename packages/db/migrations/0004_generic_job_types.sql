-- Job families and job signal types become business-neutral (config packs).
-- core = the role the business substitutes for; adjacent = roles that show the need is forming.
UPDATE "jobs" SET "family" = CASE "family" WHEN 'ops' THEN 'core' WHEN 'gtm' THEN 'adjacent' ELSE "family" END;
--> statement-breakpoint
UPDATE "signals" SET "type" = CASE "type"
  WHEN 'ops_role_open_45d' THEN 'core_role_open_45d'
  WHEN 'ops_role_open' THEN 'core_role_open'
  WHEN 'ops_role_filled' THEN 'core_role_filled'
  WHEN 'gtm_role_open' THEN 'adjacent_role_open'
  WHEN 'contract_gtm_role' THEN 'contract_role'
  WHEN 'first_gtm_role' THEN 'first_role'
  ELSE "type" END;
