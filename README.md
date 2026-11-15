# Tell — Lead Intelligence

A self-hosted signal engine that finds companies (and people) who need what **you** sell, right now, explains why with cited evidence, ranks them, finds the person to contact, drafts the opening email and sends you a daily digest. The code is generic; everything about your business lives in a private **config pack**.

The example pack (`packs/example-gtm/`) is for a freelance GTM engineer. Write your own pack for any B2B offer.

Stack: TypeScript, pnpm, Neon (Postgres), Cloudflare R2 + a Cloudflare Worker scheduler, GitHub Actions, Claude Haiku 5.5, Gmail + Google Sheets. Fixed cost ₹0 on free tiers; the spend is Haiku (hard daily cap) and a few capped paid lookups (people search, web search, JSearch).

## How it works
| Job | Schedule | What it does |
|---|---|---|
| `tick.yml` | every 30 min | HN + web search (public LinkedIn/X posts asking for help) -> keyword gate -> Haiku extractor with verbatim-quote check -> skeptical verifier -> entity resolution -> signals or person leads |
| `daily.yml` | 07:30 IST | migrate -> pack check -> JSearch -> job-board diff (new, long-open, reposted, filled roles; recruiter boards dropped) -> gigs -> Sheet label sync -> bounces -> score, contacts, emails, analyst -> digest + Sheet -> upkeep |
| `boards.yml` | Sundays | discovery (YC, Keka/Freshteam via Common Crawl, Workable, VC portfolios) through your ICP filters; account watch (site CTAs, pricing, GTM tools, DNS, certificates, lookalike domains) |

Jobs are triggered by a Cloudflare Worker (GitHub's own cron was unreliable).

**Scoring.** Each signal has a likelihood ratio and a half-life; intent adds them in log-odds, each decayed once by its own half-life. Open roles and website findings the watch still sees are *states* (current while true), not one-off events. Priority = intent x a light fit tie-break, shown as 0-100 (0 = the base rate, 50 = twice it). Plays explain the "why now"; fresh strong signals get a guaranteed slot. A lead you've seen comes back early only with a new play or new strong evidence; a 👎 needs a new play; a meeting or a win never comes back.

**Emails.** Haiku writes a cited hypothesis and an opening email from the evidence only, following your pack's copy brief. Code checks every draft (citations, verbatim quotes, no invented numbers, banned phrases, no "open 121 days", no copied brief text) and asks for a rewrite with the reasons; a draft that still fails stays empty, never a template.

## Config packs
A pack is a folder of YAML files, validated at startup:

| File | What it holds |
|---|---|
| `pack.yaml` | name, your offer, crawler identity (bot name + contact URL), timezone |
| `icp.yaml` | hard filters (size, industry, region, exclusions), soft-fit weights, reach weights, contact personas |
| `signals.yaml` | signal types, likelihood ratios, half-lives, strengths, keyword gate, eligibility, Gate 2 seeds |
| `plays.yaml` | signal combinations that explain "why now", with the angle and who to contact |
| `roles.yaml` | job-title patterns: **core** (the role you replace or bridge), **adjacent** (the need is forming), exclusions, job-ad pain phrases |
| `tools.yaml` | GTM tools detected on sites and in DNS, and which categories count as overlap |
| `extractor.yaml` | what a genuine need for your offer looks like (used in the Haiku prompts) |
| `sources.yaml` | which sources run and their queries and budgets |
| `domains.yaml` | domains that are never a lead's company (vendors, ATS hosts, free mail) |
| `critic.yaml` | vendor and already-solved rules applied before the ranking cut |
| `gigs.yaml` | freelance/contract gig rules |
| `copy.yaml` | the email copy brief: voice, how to mention what you noticed, offer ideas, closing styles, phrases never to use, examples |
| `delivery.yaml` | digest recipient, Sheet, email signature and length |

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
| `pnpm pack:check [dir\|--r2]` / `pnpm pack:push <dir> <prefix>` | validate a pack / upload it to private R2 |
| `pnpm tick` / `pnpm smoke [n]` | run the 30-minute tick (smoke = capped at n items) |
| `pnpm boards:discover` / `pnpm boards:check` / `pnpm watch` | weekly discovery / daily board diff / weekly account watch |
| `pnpm jsearch` / `pnpm gigs` | daily JSearch listings / freelance gigs |
| `pnpm score --dry --show` | score and rank without writing (local only: prints leads) |
| `pnpm digest --dry` / `--test` | render the digest to `digest-preview.html` / send a `[TEST]` copy that records nothing |
| `pnpm sheet:setup <pack>` / `pnpm sheet:sync` | create the leads Sheet / sync rows and labels |
| `pnpm tune` / `pnpm ops` / `pnpm forget` | weekly tuning proposals / nightly upkeep / delete a person everywhere |
| `pnpm network connections\|clients\|employers\|stats\|champions` | import your own network locally (warm paths); weekly past-client job-move check |
| `pnpm typecheck && pnpm test` | checks (tests use a frozen fixture pack; golden sets in `evals/`) |

Setup for a new copy: see [SETUP.md](SETUP.md). This repo is public: code only, never data, packs or secrets. Commands that print lead details refuse to run in CI.
