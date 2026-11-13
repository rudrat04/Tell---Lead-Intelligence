# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tell is a self-hosted lead-signal engine: it finds companies (and people) who need what the operator sells *right now*, explains why with cited evidence, ranks them, and emails a daily digest. The code is business-neutral; everything about a business (ICP, signals, role patterns, prompts, sources, recipients) lives in a **config pack**. The design source of truth is plan v3 (`gtm-signal-engine-plan-v3.md`, kept outside the repo); `PLAN-next.md` (git-ignored) tracks deviations, gaps and eval requirements.

**The repo is public** (free GitHub Actions minutes). Never commit packs other than `packs/example-gtm`, `.env`, `digest-preview.html`, or anything naming real leads. Scripts that run in CI must print **counts only**: Actions logs are public. `--show`, `--dry` and `--test` flags that print or render lead details refuse to run when `CI` is set.

## Commands

pnpm monorepo, Node ≥22, TypeScript run directly with `tsx` (no build step).

```bash
pnpm install
pnpm typecheck                     # tsc in every workspace package
pnpm test                          # vitest, all packages
pnpm exec vitest run packages/intel/src/rank.test.ts      # one file
pnpm exec vitest run -t "struggling to hire"              # by test name
```

Runtime jobs (need `.env`; see `.env.example`):

| Command | What it does |
|---|---|
| `pnpm db:migrate` | apply Drizzle migrations (`--baseline <tag>` only for a DB migrated by hand) |
| `pnpm db:generate` | generate a migration after editing `packages/db/src/schema.ts` (custom SQL: `cd packages/db && npx drizzle-kit generate --custom --name x`) |
| `pnpm pack:check [dir\|--r2]` / `pnpm pack:push <dir> <prefix>` | validate a pack / upload it to private R2 |
| `pnpm tick` / `pnpm smoke [n]` | 30-min tick (HN → cascade → resolution); smoke = capped at n items per source |
| `pnpm boards:discover [--yc-only\|--cc-only]` / `pnpm boards:check` | weekly discovery (YC, then Keka/Freshteam tenants from Common Crawl) / daily job-board diff |
| `pnpm gigs` | fetch freelance/contract gigs |
| `pnpm score [--dry] [--show]` | score + rank accounts |
| `pnpm digest [--dry\|--test]` | score, render, send the digest (`--dry` writes `digest-preview.html`; `--test` sends with `[TEST]` and records nothing) |
| `pnpm google:auth` | one-time OAuth (gmail.send + drive.file) to get `GMAIL_REFRESH_TOKEN` into `.env` |
| `pnpm watch` | weekly account watch: YC pages (founders, funding, launches), homepage + DNS changes, GTM tools |
| `pnpm sheet:setup <pack-dir>` / `pnpm sheet:sync` | create the leads Sheet / append pending rows + read labels back |
| `pnpm ops` | nightly upkeep: usage guard → janitor (retention) → verified backup to R2 |
| `pnpm forget --name "X" --domain d` / `--email e` | delete a person everywhere (Neon, Sheet, R2 backups) and suppress them |

Which pack loads: `TELL_PACK_R2_PREFIX` (private R2, production) > `TELL_PACK_DIR` > `packs/example-gtm`. To run locally against the operator's real pack: `TELL_PACK_R2_PREFIX=packs/main pnpm score --dry --show`.

Ad-hoc `pnpm exec tsx -e '...'` snippets run as CommonJS: use `require(...)`, wrap in an async IIFE, and `require("dotenv/config")` first.

## Architecture

Packages (`packages/*`, imported as `@tell/<name>`, `main` points at `src/index.ts`):

- **config**: pack schema (zod) + loader (local dir or R2 via aws4fetch) + `loadFixturePack()` for tests. `CODE_SIGNAL_TYPES` lists signal types the code emits; a pack must define every one.
- **db**: Drizzle schema, migrations, `getDb()` (neon-http), `migrateDb()`. Re-exports `eq/and/inArray/sql` — import them from `@tell/db`, not `drizzle-orm`, or you get duplicate-type errors from two drizzle instances.
- **watchers**: source adapters (HN/Algolia, Reddit, YC directory + jobs pages, Greenhouse/Lever/Ashby, Keka/Freshteam, Common Crawl index, Remote OK, Himalayas), robots.txt, politeness (`politeGet`, per-host gap), bot identity, and `policy.ts` (per-source terms-of-use gates).
- **extract**: the LLM gates. Gate 3 post extractor and Gate 4 verifier (Claude Haiku 5.5, prompts built from the pack), `runCascade`, `HaikuClient` (thinking disabled, cost tracking).
- **intel**: pure logic, no I/O: Gate 1 rules, Gate 5 corroboration, ICP hard filters, job classification + daily board diff, scoring/ranking, gig rules.
- **people**: entity resolution (domains via tldts with private suffixes, never-guess rules, HN profile mapping), signal/person-lead persistence, contact picking by persona.
- **pipeline**: orchestration that touches the DB: tick, board discovery/check, scoring run, contacts enrichment, gigs.
- **deliver**: digest rendering + Gmail API sender + `runDigest`.

Data flow:

```
tick (30 min):   watchers → seen-hash skip → Gate1 → Gate3 → Gate4 → resolve → signals | person_leads
daily chain:     migrate → pack:check → partitions → boards:check (diff jobs) → gigs → tick (fallback) → digest
digest:          runScoring (jobs state + signals → evidence → score → rank) → contactsFor → render → send → deliveries
weekly:          boards:discover (YC → ICP hard filters → accounts + job_boards; own-site ATS links)
                 + Common Crawl → Keka/Freshteam tenants → backlink proof → accounts + job_boards (India coverage)
```

Key invariants (each was a real bug or a deliberate design decision):

- **Job openings are state, not events.** Scoring reads the `jobs` table: an open *core* role is current (age 0); adjacent/founding roles age from posting but never past 45 days while open. Job-derived rows in `signals` are ignored by scoring (`JOB_STATE_TYPES`) so a role never counts twice.
- **Role families are generic**: `core` = the role the operator substitutes for (long-open → "struggling to hire", removed fast → filled); `adjacent` = the need is forming. Patterns live in the pack's `roles.yaml`.
- **Board diff**: a board's first check is a baseline (no "new role" signals); a role is only announced as new if posted within 14 days; an empty fetch with ≥3 open roles is "suspect" and closes nothing.
- **Seen-hash dedupe** marks only items that actually went through the cascade; `lastRunAt` advances only on a clean, complete run (catch-up after outages).
- **Never guess a domain.** With a company name, exactly one candidate domain must match it; tool/vendor/ATS/free-mail domains are excluded (`domains.yaml`); homepages must load on the same brand. Reddit authors map from the post only (Reddit Responsible Builder Policy). An ATS tenant (acme.keka.com) becomes an account only when a candidate site's own pages link back to that exact board; slugs and names only suggest which sites to check. Region comes from job locations, never from the ATS. Staffing-agency boards are skipped.
- **Month-one ranking, no threshold**: probabilities are uncalibrated; fast lane = fresh (≤14d) strong signal, guaranteed a slot, not the top.
- **Idempotency** is enforced by unique keys (signals on `evidence_url,type`; plays per account; people per account+name+source; gigs per source+external id; digest once per IST day via `runs.idempotency_key`).
- **Spend**: Haiku daily cap is persisted per IST day in `usage_daily`; every run checks remaining budget.
- `raw_items`, `candidates`, `scores` are monthly-partitioned (migration 0001); `ensure-partitions.ts` runs daily.
- Tests must use the frozen fixture pack (`packages/config/fixtures/pack`), never `packs/*`.

## Operations

- Jobs run on **GitHub Actions** (`.github/workflows`) but are **triggered by a Cloudflare Worker** (`infra/scheduler`, free plan) via `workflow_dispatch`, because GitHub's own cron was unreliable; the workflows have no `schedule:`. `tick.yml` every 30 min, `daily.yml` 07:30 IST (migrate → pack check → partitions → boards → gigs → fallback tick → sheet sync → digest → healthchecks ping → upkeep), `boards.yml` Sundays (discovery + account watch). healthchecks.io alerts if the daily ping is missing. Trigger.dev code exists (`trigger/`) but deploys are blocked for the org.
- Secrets live in GitHub repo secrets and `.env`; the pack location is the repo variable `TELL_PACK_R2_PREFIX`.
- Migrations are applied by `pnpm db:migrate` (also the first step of `daily.yml`). Never edit an applied migration.
- External sources: respect robots.txt and each source's terms (recorded in code comments: Remote OK link-back, Himalayas section 113, Reddit off pending approval). Don't bypass access controls (e.g. CSRF-protected APIs).

## Eval and improvement requirements (from the operator)

When building evals or self-tuning, cover: India coverage at every stage (the operator is India-first; YC-only discovery yields ~3.5% Indian accounts), people-not-accounts (every lead names a persona-matched contact), regression fixtures for every false-positive class found so far (contract sales hires, stale fast-lane signals, recruiter titles, old roles announced as new, "Growth Engineer", internships, full-time "consultant" gigs), and the ranking bias of large companies with many sales roles over tiny teams matching two plays.
