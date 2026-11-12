# Account setup checklist

Do these yourself (account creation and secrets are yours to enter). Put values in a local `.env` (git-ignored) and, for the deployed tick, in Trigger.dev environment variables. Never commit them: this repo is public.

## Needed for the first live tick
1. **Neon** (neon.tech): create a project, enable the `vector` extension (the first migration does `CREATE EXTENSION`), cap autoscaling at 0.5 CU. Copy the pooled connection string to `DATABASE_URL`.
   - Apply migrations: `psql "$DATABASE_URL" -f packages/db/migrations/0000_init.sql` then `0001_partitions.sql` (the `--> statement-breakpoint` lines are SQL comments, so psql accepts the files as they are).
2. **Anthropic**: create an API key, set `ANTHROPIC_API_KEY`, and set a monthly spend limit in the console. Set `HAIKU_DAILY_CAP_USD` (default 1).
3. **Trigger.dev Cloud**: create a project, put its ref in `TRIGGER_PROJECT_REF`, then `npx trigger.dev@latest login` and `npx trigger.dev deploy`. Add the env vars above in the dashboard.
4. **Reddit**: create a "script" app at reddit.com/prefs/apps with a dedicated account. Set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD`. Check Reddit's current Data API terms and approval requirements first; they have changed over time.

## Later (not needed yet)
- **Cloudflare R2**: bucket + 30-day lifecycle rule on `raw/`; set `R2_*` vars.
- **Dedicated Gmail** + Google Cloud OAuth app (set to "In production") for the digest and outreach.
- **Google Sheets** service account.
- **ICANN CZDS** access request (approval takes time; plan week 1).
