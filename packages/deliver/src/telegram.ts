import type { Contact } from "@tell/people";
import type { ScoreRunResult } from "@tell/pipeline";
import { describe, scoreLine, emailText, type LeadNote } from "./render.js";
import { sendWindow, sendWindowText } from "@tell/intel";
import type { Pack } from "@tell/config";

/**
 * Telegram delivery (pack delivery.channels includes "telegram"; TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID):
 * a summary message, then one message per lead with buttons. Button taps go to the Worker's /tg webhook:
 *   g:<delivery id> / b:<id>   label good / bad (same KV store as the email links; the daily sync moves them to the Sheet)
 *   e:<id>                      find email (queues enrich.yml, like the email's "Find email")
 *   br:<id> / dr:<id>           send the brief / the email draft (texts the digest stored in the Worker's KV via /tg-store)
 * Lead text never reaches CI logs: only counts are printed.
 */
type Lead = ScoreRunResult["ranking"]["leads"][number];
export interface TgMessage { text: string; buttons?: { text: string; data: string }[][] }

/** Telegram HTML: only &, < and > need escaping (pure; exported for tests). */
export const tgEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const link = (url: string, text: string) => (/^https?:\/\//i.test(url) ? `<a href="${tgEsc(url)}">${tgEsc(text)}</a>` : tgEsc(text));
/** Telegram caps a message at 4,096 characters: cut long text at a line (pure; exported for tests). */
export function chunks(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ""; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

/** One lead as a Telegram message (pure; exported for tests). */
export function leadMessage(l: Lead, c: Contact | null | undefined, n: LeadNote | undefined, deliveryId: string | null, date: string, pack: Pick<Pack, "icp">, test = false): TgMessage {
  const a = l.account, s = l.score;
  const lines = [
    `<b>${link(`https://${a.domain}`, a.name ?? a.domain)}</b>${a.region ? ` · ${tgEsc(a.region)}` : ""}${a.segment ? ` · ${tgEsc(a.segment)}` : ""}`,
    tgEsc(scoreLine(s)),
    ...(a.description ? [`<i>${tgEsc(a.description)}</i>`] : []),
    "",
    ...(s.plays[0] ? [`<b>Play:</b> ${tgEsc(s.plays[0].title)}`] : []),
    ...(l.backReason ? [`<b>Back:</b> ${tgEsc(l.backReason)}`] : []),
    ...s.drivers.filter((x) => x.type !== "role_gap").slice(0, 3).map((x) => `• ${link(x.url, describe(x))}`),
    ...(n?.angle ? [`<b>Angle:</b> ${tgEsc(n.angle)}`] : []),
    "",
    c ? `<b>Contact:</b> ${tgEsc(c.person.name)}${c.person.role ? `, ${tgEsc(c.person.role)}` : ""}` : "<b>Contact:</b> none found yet",
    ...(c && emailText(c.person) ? [`✉️ ${tgEsc(emailText(c.person)!)}`] : []),
    ...(c?.person.linkedin ? [link(c.person.linkedin, "LinkedIn")] : []),
    ...(pack.icp.calendar ? [`⏱ ${tgEsc(sendWindowText(sendWindow(s.evidence, new Date(`${date}T00:00:00Z`), pack.icp.calendar)))}`] : []),
  ];
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n");
  if (!deliveryId || test) return { text };
  const row2 = [{ text: "📨 Draft", data: `dr:${deliveryId}` }, ...(n?.brief ? [{ text: "📄 Brief", data: `br:${deliveryId}` }] : [])];
  const needsEmail = !c?.person.email || !["observed", "verified"].includes(c.person.email.status);
  return { text, buttons: [[{ text: "👍 Good", data: `g:${deliveryId}` }, { text: "👎 Bad", data: `b:${deliveryId}` }], [...(needsEmail && c ? [{ text: "🔎 Find email", data: `e:${deliveryId}` }] : []), ...row2]] };
}

/** The opening message: counts per list, touch-backs, health (pure; exported for tests). */
export function summaryMessage(r: ScoreRunResult, date: string, extra: { touchBacks?: number; health?: string; test?: boolean } = {}): TgMessage {
  const leads = r.ranking.leads;
  const groups = new Map<string, number>();
  for (const l of leads) groups.set(l.group ?? "Leads", (groups.get(l.group ?? "Leads") ?? 0) + 1);
  const lines = [
    `${extra.test ? "[TEST] " : ""}<b>${leads.length ? `${leads.length} ${leads.length === 1 ? "lead" : "leads"} for ${tgEsc(date)}` : `No new leads for ${tgEsc(date)}`}</b>`,
    ...[...groups].map(([g, k]) => `• ${tgEsc(g)}: ${k}`),
    ...(extra.touchBacks ? [`↩️ ${extra.touchBacks} past ${extra.touchBacks === 1 ? "lead has" : "leads have"} a new fact (Touch back in the Sheet)`] : []),
    ...(extra.health ? ["", `<i>${tgEsc(extra.health)}</i>`] : []),
  ];
  return { text: lines.join("\n") };
}

export function telegramConfigured(): boolean { return !!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_CHAT_ID; }

/** Send messages in order, about one a second (Telegram's per-chat limit), retrying a 429 once after its retry_after. */
export async function sendTelegram(msgs: TgMessage[], opts: { token?: string; chatId?: string; fetcher?: typeof fetch; pauseMs?: number } = {}): Promise<number> {
  const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN, chat = opts.chatId ?? process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return 0;
  const f = opts.fetcher ?? fetch;
  let sent = 0;
  for (const m of msgs) {
    const parts = chunks(m.text);
    for (let i = 0; i < parts.length; i++) {
      const body = { chat_id: chat, text: parts[i], parse_mode: "HTML", disable_web_page_preview: true,
        ...(m.buttons && i === parts.length - 1 ? { reply_markup: { inline_keyboard: m.buttons.filter((row) => row.length).map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}) };
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await f(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (res.ok) { sent++; break; }
        const j = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number }; description?: string };
        if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, ((j.parameters?.retry_after ?? 3) + 1) * 1000)); continue; }
        throw new Error(`telegram ${res.status}: ${j.description ?? ""}`.slice(0, 160));
      }
      await new Promise((r) => setTimeout(r, opts.pauseMs ?? 1100));
    }
  }
  return sent;
}

/** Hand the brief and the email draft to the Worker, so the Brief / Draft buttons can send them later (KV, 30 days). */
export async function storeTelegramTexts(items: { d: string; brief?: string; draft?: string }[], opts: { url?: string; secret?: string; fetcher?: typeof fetch } = {}): Promise<boolean> {
  const url = opts.url ?? process.env.TELL_LABEL_URL, secret = opts.secret ?? process.env.LABEL_SECRET;
  if (!url || !secret || !items.length) return false;
  const res = await (opts.fetcher ?? fetch)(`${url.replace(/\/$/, "")}/tg-store`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(items.slice(0, 100)) });
  return res.ok;
}
