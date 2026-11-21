-- One opportunity lead per account per IST day: a retried opportunity digest skips leads it already wrote
-- (INSERT ... ON CONFLICT DO NOTHING). Partial on kind = 'opportunity' so older rows of other kinds are untouched.
CREATE UNIQUE INDEX "deliveries_opp_day_uq" ON "deliveries" ("account_id", (timezone('Asia/Kolkata', "delivered_at")::date)) WHERE "kind" = 'opportunity';
