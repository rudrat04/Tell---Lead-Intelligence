/**
 *   pnpm credits [--json <file>] [--dashboard <dir>]
 *
 * Every paid / free-tier API Tell uses: the provider's own live balance where it has an endpoint that costs nothing
 * (Serper, Tavily, Firecrawl, Hunter, Prospeo, Diffbot, Apollo, QEV sandbox), whether each Exa key still answers (one
 * search per key, ~$0.005 each), and what Tell itself counted in usage_daily (today and this month vs its caps).
 * Prints numbers only, never keys. --json writes the snapshot the usage dashboard is built from (local only: the
 * file is git-ignored).
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { getDb, sql } from "@tell/db";

if (process.env.CI) { console.error("credits: local only"); process.exit(1); }
const env = process.env;
const T = 20_000;
type Live = { provider: string; status: "ok" | "low" | "out" | "error" | "no key"; used?: number; limit?: number; remaining?: number; unit?: string; note?: string };

const get = async (url: string, init: RequestInit = {}) => {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(T) });
  const text = await r.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  return { ok: r.ok, status: r.status, body, headers: r.headers };
};
const st = (remaining?: number, limit?: number): Live["status"] => remaining == null ? "ok" : remaining <= 0 ? "out" : limit && remaining / limit < 0.15 ? "low" : "ok";
const err = (provider: string, e: unknown): Live => ({ provider, status: "error", note: String((e as Error)?.message ?? e).slice(0, 160) });

const checks: Record<string, () => Promise<Live | Live[]>> = {
  async exa() {
    const one = async (name: string, key?: string): Promise<Live> => {
      if (!key) return { provider: name, status: "no key" };
      const r = await get("https://api.exa.ai/search", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify({ query: "exa", numResults: 1 }) });
      if (r.ok) return { provider: name, status: "ok", note: "key answers (Exa has no balance API: see dashboard.exa.ai)" };
      return { provider: name, status: [401, 402, 403, 429].includes(r.status) ? "out" : "error", note: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}` };
    };
    return [await one("Exa (key 1)", env.EXA_API_KEY), await one("Exa (key 2)", env.EXA_API_KEY_2)];
  },
  async serper() {
    if (!env.SERPER_API_KEY) return { provider: "Serper", status: "no key" };
    const r = await get("https://google.serper.dev/account", { headers: { "X-API-KEY": env.SERPER_API_KEY } });
    if (!r.ok) return { provider: "Serper", status: "error", note: `HTTP ${r.status}` };
    const remaining = Number(r.body.balance);
    return { provider: "Serper", status: st(remaining, 2500), remaining, unit: "credits" };
  },
  async tavily() {
    if (!env.TAVILY_API_KEY) return { provider: "Tavily", status: "no key" };
    const r = await get("https://api.tavily.com/usage", { headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}` } });
    if (!r.ok) return { provider: "Tavily", status: "error", note: `HTTP ${r.status}` };
    const a = r.body.account ?? {}, k = r.body.key ?? {};
    const used = Number(a.plan_usage ?? k.usage ?? 0), limit = Number(a.plan_limit ?? k.limit ?? 0) || undefined;
    return { provider: "Tavily", status: st(limit != null ? limit - used : undefined, limit), used, ...(limit ? { limit, remaining: limit - used } : {}), unit: "credits / month" };
  },
  async firecrawl() {
    if (!env.FIRECRAWL_API_KEY) return { provider: "Firecrawl", status: "no key" };
    const r = await get("https://api.firecrawl.dev/v1/team/credit-usage", { headers: { Authorization: `Bearer ${env.FIRECRAWL_API_KEY}` } });
    if (!r.ok) return { provider: "Firecrawl", status: "error", note: `HTTP ${r.status}` };
    const remaining = Number(r.body.data?.remaining_credits ?? r.body.remaining_credits);
    return { provider: "Firecrawl", status: st(remaining, 500), remaining, unit: "credits" };
  },
  async hunter() {
    if (!env.HUNTER_API_KEY) return { provider: "Hunter", status: "no key" };
    const r = await get(`https://api.hunter.io/v2/account?api_key=${env.HUNTER_API_KEY}`);
    if (!r.ok) return { provider: "Hunter", status: "error", note: `HTTP ${r.status}` };
    const q = r.body.data?.requests ?? {}, s = q.searches ?? {}, v = q.verifications ?? {};
    const cr = r.body.data?.requests?.credits;
    if (cr) return { provider: "Hunter", status: st(cr.available - cr.used, cr.available), used: cr.used, limit: cr.available, remaining: cr.available - cr.used, unit: "credits / month", note: r.body.data?.reset_date ? `resets ${r.body.data.reset_date}` : undefined };
    return { provider: "Hunter", status: st(s.available - s.used, s.available), used: s.used, limit: s.available, remaining: s.available - s.used, unit: "searches / month",
      note: `verifications ${v.used ?? "?"}/${v.available ?? "?"}${r.body.data?.reset_date ? `, resets ${r.body.data.reset_date}` : ""}` };
  },
  async prospeo() {
    if (!env.PROSPEO_API_KEY) return { provider: "Prospeo", status: "no key" };
    const r = await get("https://api.prospeo.io/account-information", { method: "POST", headers: { "X-KEY": env.PROSPEO_API_KEY, "Content-Type": "application/json" }, body: "{}" });
    if (!r.ok) return { provider: "Prospeo", status: "error", note: `HTTP ${r.status}` };
    const d = r.body.response ?? r.body;
    const remaining = Number(d.remaining_credits), used = d.used_credits != null ? Number(d.used_credits) : undefined;
    return { provider: "Prospeo", status: st(remaining, used != null ? used + remaining : undefined), remaining, ...(used != null ? { used, limit: used + remaining } : {}), unit: "credits", note: d.next_quota_renewal_date ? `renews ${String(d.next_quota_renewal_date).slice(0, 10)}` : undefined };
  },
  async diffbot() {
    if (!env.DIFFBOT_TOKEN) return { provider: "Diffbot", status: "no key" };
    const r = await get(`https://api.diffbot.com/v4/account?token=${env.DIFFBOT_TOKEN}`);
    if (!r.ok) return { provider: "Diffbot", status: "error", note: `HTTP ${r.status}` };
    const used = Number(r.body.usage?.credits ?? r.body.credits ?? r.body.usage?.[0]?.credits ?? NaN), limit = Number(r.body.planCredits ?? r.body.plan?.credits ?? NaN);
    return { provider: "Diffbot", status: Number.isFinite(used) && Number.isFinite(limit) ? st(limit - used, limit) : "ok", ...(Number.isFinite(used) ? { used } : {}), ...(Number.isFinite(limit) ? { limit, remaining: limit - used } : {}), unit: "credits", note: r.body.plan ? `plan ${typeof r.body.plan === "string" ? r.body.plan : r.body.plan.name ?? ""}` : undefined };
  },
  async apollo() {
    if (!env.APOLLO_API_KEY) return { provider: "Apollo", status: "no key" };
    const r = await get("https://api.apollo.io/api/v1/auth/health", { headers: { "X-Api-Key": env.APOLLO_API_KEY } });
    return { provider: "Apollo", status: r.ok ? "ok" : "error", note: r.ok ? "key answers (credits: app.apollo.io settings)" : `HTTP ${r.status}` };
  },
  async qev() {
    if (!env.QUICKEMAILVERIFICATION_API_KEY) return { provider: "QuickEmailVerification", status: "no key" };
    const r = await get(`https://api.quickemailverification.com/v1/verify/sandbox?email=valid@example.com&apikey=${env.QUICKEMAILVERIFICATION_API_KEY}`);
    const h = r.headers.get("x-qev-remaining-credits");
    if (!r.ok) return { provider: "QuickEmailVerification", status: "error", note: `HTTP ${r.status}` };
    return h != null ? { provider: "QuickEmailVerification", status: st(Number(h), 100), remaining: Number(h), unit: "credits today" } : { provider: "QuickEmailVerification", status: "ok", note: "key answers (no balance in sandbox)" };
  },
};

const live: Live[] = [];
for (const [name, f] of Object.entries(checks)) {
  try { const r = await f(); live.push(...(Array.isArray(r) ? r : [r])); } catch (e) { live.push(err(name, e)); }
}

// what Tell counted itself (usage_daily): today and the month so far, with the cap the row was written under
const db = getDb();
const rows = (await db.execute(sql`
  with d as (select (now() at time zone 'Asia/Kolkata')::date today)
  select service,
    coalesce(sum(used) filter (where day = (select today from d)), 0)::float as today,
    coalesce(max("limit") filter (where day = (select today from d)), max("limit"))::float as daily_limit,
    sum(used) filter (where day >= date_trunc('month', (select today from d)))::float as month,
    count(*) filter (where day >= date_trunc('month', (select today from d)))::int as days
  from usage_daily where day >= (select today from d) - 35 group by service order by service`)) as any;
const counted = (rows.rows ?? rows) as { service: string; today: number; daily_limit: number | null; month: number; days: number }[];
const history = ((await db.execute(sql`select day::text, service, used::float from usage_daily where day >= (now() at time zone 'Asia/Kolkata')::date - 29 order by day`)) as any);

for (const l of live) console.log(`${l.status.padEnd(7)} ${l.provider.padEnd(24)} ${l.remaining ?? ""}${l.limit ? ` left of ${l.limit}` : ""} ${l.unit ?? ""} ${l.note ?? ""}`.trimEnd());
console.log(`\nusage_daily services: ${counted.length}`);
// --dashboard <dir>: the usage dashboard's three files (rows, one JSON array each)
const PROVIDER: [RegExp, string][] = [[/^exa/, "Exa"], [/^serper/, "Serper"], [/^(haiku|sonnet)/, "Anthropic"], [/^hunter/, "Hunter"], [/^prospeo/, "Prospeo"],
  [/^apollo/, "Apollo"], [/^qev/, "QuickEmailVerification"], [/^inboxtrue/, "InboxTrue"], [/^firecrawl/, "Firecrawl"], [/^jsearch/, "JSearch"], [/^diffbot/, "Diffbot"],
  [/^brandfetch/, "Brandfetch"], [/^google_places/, "Google Maps"], [/^sam/, "SAM.gov"], [/^tavily/, "Tavily"], [/_storage_gb$/, "Storage"], [/^alerts$/, "Alerts"]];
const providerOf = (svc: string) => PROVIDER.find(([rx]) => rx.test(svc))?.[1] ?? "Other";
const MONTHLY = /^(hunter|prospeo|apollo|jsearch|google_places|brandfetch_brand|exa_searches_month)$/; // caps counted over a month (or all time) rather than a day
const UNIT = (svc: string) => (/^(haiku|sonnet)/.test(svc) ? "USD" : /_storage_gb$/.test(svc) ? "GB" : "calls");
const d = process.argv.indexOf("--dashboard");
if (d > 0) {
  const dir = process.argv[d + 1]!, at = new Date().toISOString();
  const r4 = (x: number | null | undefined) => (x == null ? null : Math.round(x * 10000) / 10000);
  const balances = live.map((l) => ({ provider: l.provider, status: l.status, remaining: l.remaining ?? null, limit: l.limit ?? null, used: l.used ?? null, unit: l.unit ?? "", note: l.note ?? "", checked_at: at }));
  const caps = counted.filter((c) => !/_storage_gb$/.test(c.service)).map((c) => {
    const monthly = MONTHLY.test(c.service), now = monthly ? (c.service === "exa_searches_month" ? c.today : c.month) : c.today;
    return { service: c.service, provider: providerOf(c.service), unit: UNIT(c.service), period: c.service === "brandfetch_brand" ? "all time" : monthly ? "month" : "day", used: r4(now), cap: r4(c.daily_limit), share: c.daily_limit ? r4(now / c.daily_limit) : null, month_total: r4(c.service === "exa_searches_month" ? c.today : c.month) };
  });
  const hist = ((history.rows ?? history) as { day: string; service: string; used: number }[]).filter((h) => !/_storage_gb$|^exa_searches_month$/.test(h.service));
  const byDay = new Map<string, { day: string; provider: string; unit: string; used: number }>();
  for (const h of hist) {
    const p = providerOf(h.service), u = UNIT(h.service), k = `${h.day}|${p}|${u}`;
    const row = byDay.get(k) ?? { day: h.day, provider: p, unit: u, used: 0 };
    row.used += h.used;
    byDay.set(k, row);
  }
  const daily = [...byDay.values()].map((r) => ({ ...r, used: r4(r.used) })).sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider));
  writeFileSync(`${dir}/balances.json`, JSON.stringify(balances));
  writeFileSync(`${dir}/caps.json`, JSON.stringify(caps));
  writeFileSync(`${dir}/daily.json`, JSON.stringify(daily));
  console.log(`wrote balances.json (${balances.length}), caps.json (${caps.length}), daily.json (${daily.length}) to ${dir}`);
}
const i = process.argv.indexOf("--json");
if (i > 0) {
  writeFileSync(process.argv[i + 1]!, JSON.stringify({ at: new Date().toISOString(), live, counted, history: history.rows ?? history }, null, 1));
  console.log(`wrote ${process.argv[i + 1]}`);
}
