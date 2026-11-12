# Tell — Lead Intelligence

GTM signal engine: finds companies and agencies that need a GTM engineer *now*, with cited evidence and calibrated scores. Build plan: v3 (see project docs).

Stack: TypeScript, pnpm, Neon + Drizzle + pgvector, Cloudflare R2, Trigger.dev, GitHub Actions, Claude Haiku.

## Status
Week 1 scaffold: DB schema, watcher interface + fallbacks, HN and ATS watchers, scoring math (tested), config drafts.

## Dev
```
pnpm install
pnpm typecheck && pnpm test
```
Copy `.env.example` to `.env` and fill in credentials. This repo is public: code only, never data or secrets.
