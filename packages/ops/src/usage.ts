import { r2 } from "@tell/config";
import { getDb, usageDaily, sql } from "@tell/db";

/**
 * Free-tier usage guard (plan section 2). Records today's usage per service in usage_daily; `tight` when any is at
 * 80%+ of its limit, which makes the janitor halve retention windows. Limits are env-overridable.
 * (Neon compute hours need a Neon API key and aren't measured here.)
 */
export interface UsageReading { service: string; used: number; limit: number; unit: string; pct: number }
export interface UsageResult { readings: UsageReading[]; tight: boolean }

const DAY = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export async function runUsageGuard(): Promise<UsageResult> {
  const db = getDb();
  const day = DAY();
  const env = process.env;
  const readings: UsageReading[] = [];
  const add = (service: string, used: number, limit: number, unit: string) => readings.push({ service, used, limit, unit, pct: limit > 0 ? used / limit : 0 });

  const [size] = (await db.execute(sql`select pg_database_size(current_database())::bigint as b`)).rows as { b: string }[];
  add("neon_storage_gb", Number(size?.b ?? 0) / 1e9, Number(env.NEON_STORAGE_LIMIT_GB ?? 0.5), "GB");

  try {
    const objects = await r2().list("");
    add("r2_storage_gb", objects.reduce((a, o) => a + o.size, 0) / 1e9, Number(env.R2_STORAGE_LIMIT_GB ?? 10), "GB");
  } catch { /* R2 not configured: skip */ }

  const [haiku] = (await db.execute(sql`select coalesce(sum(used), 0)::float as used from usage_daily where service = 'haiku' and day = ${day}`)).rows as { used: number }[];
  add("haiku_usd_today", haiku?.used ?? 0, Number(env.HAIKU_DAILY_CAP_USD ?? 1), "USD");

  const [exa] = (await db.execute(sql`select count(*)::int as n from people_searches where provider = 'exa' and searched_at >= date_trunc('month', now())`)).rows as { n: number }[];
  add("exa_searches_month", exa?.n ?? 0, Number(env.EXA_MONTHLY_SEARCHES ?? 1400), "searches");

  for (const r of readings.filter((x) => x.service !== "haiku_usd_today")) {
    await db.insert(usageDaily).values({ day, service: r.service, used: r.used, limit: r.limit })
      .onConflictDoUpdate({ target: [usageDaily.day, usageDaily.service], set: { used: r.used, limit: r.limit } });
  }
  return { readings, tight: readings.some((r) => r.pct >= 0.8) };
}
