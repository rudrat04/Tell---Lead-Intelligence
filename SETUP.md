# Setting up your own copy

Each business runs its own copy with its own accounts and keys. Create the accounts and enter the keys yourself, in a local `.env` (git-ignored) and as GitHub repository secrets. Never commit keys or your real pack: the repo is public.

## 1. Copy the code
Create your repository from this one (GitHub: **Use this template**), keep it **public** (free Actions minutes), then:
```
pnpm install
cp .env.example .env
```

## 2. Accounts (free tiers)
1. **Neon** (neon.tech): create a project (Postgres only; no other services needed). Cap autoscaling at 0.5 CU (Settings, Compute). Copy the **pooled** connection string to `DATABASE_URL`.
2. **Anthropic** (console.anthropic.com): create an API key (`ANTHROPIC_API_KEY`) and set a monthly spend limit. `HAIKU_DAILY_CAP_USD` caps daily spend in code (default 1).
3. **Cloudflare R2**: create a bucket and an API token with Object Read & Write on that bucket only. Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Your private pack lives here.
4. **Reddit: optional and on hold.** Reddit's Responsible Builder Policy requires approval before any API access, and written approval for commercial use. Request it honestly via the commercial contact link in that policy. Until approved, Reddit stays off in code (`packages/watchers/src/policy.ts`). The policy bans re-identifying users, so Reddit authors are only ever linked to a company the post itself names or links.

## 3. Database
```
pnpm db:migrate
```

## 4. Your config pack
```
cp -R packs/example-gtm packs/my-pack     # packs/my-pack is git-ignored; edit it for your business
pnpm pack:check packs/my-pack
pnpm pack:push packs/my-pack packs/main   # private copy in R2
```
Start with `pack.yaml` (your offer, bot name, contact URL), `icp.yaml`, `extractor.yaml` and `roles.yaml`. The likelihood ratios in `signals.yaml` are starting guesses that improve once you label leads.

## 5. GitHub secrets and variables
Repository **secrets**: `DATABASE_URL`, `ANTHROPIC_API_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
Repository **variables**: `TELL_PACK_R2_PREFIX` (e.g. `packs/main`), `HAIKU_DAILY_CAP_USD`.

From the repo folder, each secret can be copied from `.env` without pasting it anywhere:
```
gh secret set DATABASE_URL --body "$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
```

## 6. Check it runs
```
pnpm boards:discover   # seeds companies through your ICP
pnpm smoke 5           # one capped tick
```
Then run the workflows once from the Actions tab (`workflow_dispatch`). GitHub can take a while to start scheduled runs on a new repository.

## Later
- **Digest**: a dedicated Gmail + Google Cloud OAuth client (steps arrive with the digest feature).
- **Google Sheet**: a service account.
- **ICANN CZDS** access, for lookalike-domain signals (approval takes time).
