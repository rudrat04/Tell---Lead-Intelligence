import { industryCounts, type Pack } from "@tell/config";
import { sendTelegram, telegramConfigured, tgEsc } from "./telegram.js";
import { getDb, signals, accounts, people, companySeeds, deliveries, eq, and, sql, inArray, desc } from "@tell/db";
import { neonUsage } from "@tell/pipeline";
import type { Sender } from "./gmail.js";

const DAY = 86_400_000;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "$5.2M" / "$1.1B" in a quote -> dollars (0 when none). Exported for tests. */
export function quoteDollars(q: string): number {
  const m = q.match(/\$([\d.]+)([KMB])/);
  return m ? Number(m[1]) * (m[2] === "B" ? 1e9 : m[2] === "M" ? 1e6 : 1e3) : 0;
}

/** signal types whose quote carries a contract value (USASpending) */
export const CONTRACT_AMOUNT_TYPES = new Set(["contract_won", "contract_expiring"]);

export interface AlertResult { candidates: number; sent: number; noContact: number; /** fresh signals its industry doesn't count (industries.yaml signals) */ offIndustry?: number; skipped?: string }

/**
 * Every tick: a short same-day email for the strongest fresh signals (delivery.alerts.types; contracts only over
 * min_contract_usd) at accounts with a named contact and no recent delivery. Each account + signal alerts once
 * (company_seeds "alert"), at most max_per_day a day. The full lead (draft, Sheet row) still comes in the next digest.
 */
export async function runAlerts(opts: { pack: Pack; sender: Sender | null; now?: Date; dryRun?: boolean }): Promise<AlertResult> {
  const cfg = opts.pack.delivery.alerts;
  const res: AlertResult = { candidates: 0, sent: 0, noContact: 0 };
  if (!cfg?.enabled || !cfg.types.length) return { ...res, skipped: "alerts off in the pack" };
  const { to, from, from_name } = opts.pack.delivery.digest;
  // alerts follow the digest's channels: email (Gmail sender) and / or Telegram (instant on the phone)
  const byEmail = opts.pack.delivery.channels.includes("email") && !!to && !!from && !!opts.sender;
  const byTg = opts.pack.delivery.channels.includes("telegram") && telegramConfigured();
  if (!byEmail && !byTg && !opts.dryRun) return { ...res, skipped: "no delivery channel for alerts" };
  const db = getDb(), now = opts.now ?? new Date(), usage = neonUsage();
  const left = cfg.max_per_day - (await usage.spentToday("alerts"));
  if (left <= 0) return { ...res, skipped: "daily alert cap reached" };
  const fresh = await db.select({ id: signals.id, accountId: signals.accountId, type: signals.type, quote: signals.evidenceQuote, url: signals.evidenceUrl, at: signals.observedAt })
    .from(signals).where(and(inArray(signals.type, cfg.types), sql`${signals.observedAt} > ${new Date(now.getTime() - 3 * DAY)}`, sql`${signals.accountId} is not null`))
    .orderBy(desc(signals.observedAt)).limit(50);
  // a contract award or expiry alerts only over min_contract_usd (a contract *role* or a freeze-to-contract has no amount)
  const strong = fresh.filter((s) => !CONTRACT_AMOUNT_TYPES.has(s.type) || quoteDollars(s.quote) >= cfg.min_contract_usd);
  res.candidates = strong.length;
  for (const s of strong) {
    if (res.sent >= left) break;
    const key = `${s.accountId}:${s.type}`;
    const [done] = await db.select({ k: companySeeds.sourceId }).from(companySeeds).where(and(eq(companySeeds.source, "alert"), eq(companySeeds.sourceId, key))).limit(1);
    if (done) continue;
    // not if it went out in a digest recently (the redelivery window)
    const [recent] = await db.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.accountId, s.accountId!), sql`${deliveries.deliveredAt} > ${new Date(now.getTime() - opts.pack.delivery.redeliver_after_days * DAY)}`)).limit(1);
    if (recent) continue;
    const [acc] = await db.select({ name: accounts.name, domain: accounts.domain, segment: accounts.segment }).from(accounts).where(eq(accounts.id, s.accountId!)).limit(1);
    const contacts = await db.select({ name: people.fullName, role: people.role, source: people.source }).from(people).where(eq(people.accountId, s.accountId!)).limit(3);
    if (!acc || !contacts.length) { res.noContact++; continue; }
    // a signal its industry doesn't count is no lead (a contract award on a SaaS company); the play must be one for it
    if (!industryCounts(opts.pack, acc.segment, s.type)) { res.offIndustry = (res.offIndustry ?? 0) + 1; continue; }
    const play = Object.values(opts.pack.plays.plays).find((p) => p.requires.includes(s.type) && (!p.industries.length || (!!acc.segment && p.industries.includes(acc.segment))));
    const who = contacts.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`).join(", ");
    const subject = `Lead now: ${acc.name ?? acc.domain}${play ? ` · ${play.title}` : ""}`;
    const text = `${acc.name ?? acc.domain} (${acc.domain})\n\n${s.quote}\n${s.url}\n\nContact: ${who}\n${play ? `Play: ${play.title}\n` : ""}Free list: pnpm freelist ${acc.domain}\n\nThe full lead (draft, Sheet row) comes in tomorrow's digest.`;
    const html = `<p><b>${esc(acc.name ?? acc.domain)}</b> (${esc(acc.domain)})</p><p>${esc(s.quote)}<br><a href="${esc(s.url)}">source record</a></p><p>Contact: ${esc(who)}${play ? `<br>Play: ${esc(play.title)}` : ""}</p><p>Free list: <code>pnpm freelist ${esc(acc.domain)}</code></p><p style="color:#888">The full lead (draft, Sheet row) comes in tomorrow's digest.</p>`;
    if (opts.dryRun) { res.sent++; continue; } // counted as "would send"
    await usage.addSpend("alerts", 1, cfg.max_per_day);
    if (byEmail) await opts.sender!.send({ from: from!, fromName: from_name, to: to!, subject, html, text });
    if (byTg) await sendTelegram([{ text: `🚨 <b>${tgEsc(subject)}</b>\n\n${tgEsc(s.quote)}\n<a href="${tgEsc(s.url)}">source</a>\n\nContact: ${tgEsc(who)}${play ? `\nPlay: ${tgEsc(play.title)}` : ""}\n<i>The full lead comes in tomorrow's digest.</i>` }]).catch(() => 0);
    await db.insert(companySeeds).values({ source: "alert", sourceId: key, fitPass: true, reason: s.id, siteCheckedAt: now, updatedAt: now }).onConflictDoNothing();
    res.sent++;
  }
  return res;
}
