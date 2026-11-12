import { getDb, usageDaily, and, eq, sql } from "@tell/db";

/** Calendar day in IST (the digest and budgets run on Indian time). */
export const istDay = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export interface UsageStore {
  spentToday(service: string): Promise<number>;
  addSpend(service: string, usd: number, limit: number): Promise<void>;
}

/** Daily spend persisted in Neon `usage_daily`, so the cap holds across every tick of the day. */
export function neonUsage(url = process.env.DATABASE_URL): UsageStore {
  const db = getDb(url);
  return {
    async spentToday(service) {
      const r = await db.select({ used: usageDaily.used }).from(usageDaily)
        .where(and(eq(usageDaily.day, istDay()), eq(usageDaily.service, service))).limit(1);
      return r[0]?.used ?? 0;
    },
    async addSpend(service, usd, limit) {
      if (usd <= 0) return;
      await db.insert(usageDaily).values({ day: istDay(), service, used: usd, limit })
        .onConflictDoUpdate({
          target: [usageDaily.day, usageDaily.service],
          set: { used: sql`${usageDaily.used} + ${usd}`, limit },
        });
    },
  };
}
