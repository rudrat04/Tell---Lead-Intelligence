# Tell — Lead Intelligence

A self-hosted signal engine that finds companies who need what **you** sell, right now, explains why with cited evidence, and ranks them. The code is generic; everything about your business lives in a private **config pack**.

The example pack (`packs/example-gtm/`) is for a freelance GTM engineer. Write your own pack for any B2B offer.

Stack: TypeScript, pnpm, Neon (Postgres + pgvector), Cloudflare R2, GitHub Actions, Claude Haiku. Fixed cost ₹0 on free tiers; the only spend is Haiku, with a hard daily cap.

## How it works
| Job | Schedule | What it does |
|---|---|---|
| `tick.yml` | every 30 min | HN -> precision cascade (keyword gate, Haiku classifier with verbatim-quote check, skeptical verifier) -> entity resolution -> signals or person leads |
| `daily.yml` | daily 07:30 IST | partitions -> job-board diff (new roles, roles open 45+ days, roles filled) -> scoring and digest (coming) |
| `boards.yml` | weekly | YC companies -> your ICP hard filters -> accounts + their job boards |

Not built yet: scoring run, digest and Sheet, analyst and critic, Gate 2, more sources. Reddit is off pending Reddit API approval.

## Config packs
A pack is a folder of YAML files, validated at startup:

| File | What it holds |
|---|---|
| `pack.yaml` | name, your offer, crawler identity (bot name + contact URL), timezone |
| `icp.yaml` | hard filters (size, industry, status, exclusions) and soft-fit weights |
| `signals.yaml` | signal types, likelihood ratios, half-lives, strengths, keyword gate |
| `plays.yaml` | signal combinations that explain "why now", with the opening angle |
| `roles.yaml` | job-title patterns: **core** (the role you replace or bridge) and **adjacent** (the need is forming) |
| `extractor.yaml` | what a genuine need for your offer looks like (used in the Haiku prompts) |
| `sources.yaml` | which sources run, HN queries, subreddits |
| `domains.yaml` | domains that are never a lead's company (vendors in your space, free mail) |
| `delivery.yaml` | digest recipient and settings |

**Keep your real pack private.** It holds your ICP, exclusions and recipient. The repo must stay public for free Actions minutes, so the pack is loaded from a private R2 location in production:

```
pnpm pack:check packs/my-pack          # validate
pnpm pack:push packs/my-pack packs/main  # upload privately to R2
```
Then set the repository variable `TELL_PACK_R2_PREFIX=packs/main`. Without it, jobs fall back to the example pack.

## Commands
| Command | Does |
|---|---|
| `pnpm db:migrate` | create or update the database schema |
| `pnpm pack:check [dir\|--r2]` | validate a pack |
| `pnpm pack:push <dir> <prefix>` | upload a pack to private R2 |
| `pnpm tick` / `pnpm smoke [n]` | run the 30-minute tick (smoke = capped at n items) |
| `pnpm boards:discover` / `pnpm boards:check` | weekly discovery / daily board diff |
| `pnpm typecheck && pnpm test` | checks (tests use a frozen fixture pack) |

Setup for a new copy: see [SETUP.md](SETUP.md). This repo is public: code only, never data, packs or secrets.
