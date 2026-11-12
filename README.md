# Tell — Lead Intelligence

GTM signal engine: finds companies and agencies that need a GTM engineer *now*, with cited evidence and calibrated scores. Build plan: v3 (see project docs).

Stack: TypeScript, pnpm, Neon + Drizzle + pgvector, Cloudflare R2, Trigger.dev, GitHub Actions, Claude Haiku.

## Status
Running on GitHub Actions (Trigger.dev deployments are blocked for this org for now):

| Job | Schedule | What it does |
|---|---|---|
| `tick.yml` | every 30 min | HN -> precision cascade (Gates 1, 3, 4) -> entity resolution -> signals / person leads |
| `boards.yml` discover | weekly | YC companies -> ICP hard filters (`config/icp.yaml`) -> accounts + YC jobs pages + ATS boards linked from their own sites |
| `boards.yml` check | daily | diff each board's GTM/ops roles -> new-role, 45-day-open and filled signals |

Not built yet: scoring run, plays, analyst/critic, digest + Sheet, Gate 2, R2 raw storage. Reddit is off pending API approval.

Manual runs: `pnpm smoke`, `pnpm tick`, `pnpm boards:discover`, `pnpm boards:check`.

## Dev
```
pnpm install
pnpm typecheck && pnpm test
```
Copy `.env.example` to `.env` and fill in credentials. This repo is public: code only, never data or secrets.
