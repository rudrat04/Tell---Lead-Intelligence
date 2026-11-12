import type { Pack } from "@tell/config";
import type { Evidence } from "@tell/intel";
import type { ScoreRunResult } from "@tell/pipeline";

/** Daily digest (plan section 10). "Why now" is written by code from cited evidence: free and deterministic. */

export interface DigestHealth {
  boardsChecked24h: number;
  boardsTotal: number;
  boardsFailing: number;
  ticks24h: number;
  tickErrors24h: number;
  haikuTodayUsd: number;
  haikuCapUsd: number;
}

export interface DigestEmail { subject: string; html: string; text: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const ago = (d: number) => (d >= 60 ? `${Math.round(d / 30)} months` : `${Math.round(d)} days`);

/** One human line per piece of evidence. */
export function describe(e: Evidence): string {
  const t = `"${e.quote}"`;
  switch (e.type) {
    case "core_role_open_45d": return `${t} open ${ago(e.openDays ?? 45)}`;
    case "core_role_open": return `Hiring ${t}${e.openDays != null ? `, open ${ago(e.openDays)}` : ""}`;
    case "first_role": return `Founding hire: ${t}`;
    case "contract_role": return `Contract role: ${t}`;
    case "adjacent_role_open": return `Hiring ${t}`;
    case "explicit_hire_request": return `Asked for help: ${t}`;
    case "pain_post": return `Pain in public: ${t}`;
    default: return `${e.type}: ${t}`;
  }
}

type Lead = ScoreRunResult["ranking"]["leads"][number];

function leadHtml(l: Lead, i: number): string {
  const a = l.account, s = l.score;
  const play = s.plays[0];
  const facts = [a.sizeBand && `${a.sizeBand} people`, a.segment?.toUpperCase(), a.region].filter(Boolean).join(" · ");
  const why = s.drivers.slice(0, 4).map((e) => `<li style="margin:2px 0"><a href="${esc(e.url)}" style="color:#1a56db;text-decoration:none">${esc(describe(e))}</a></li>`).join("");
  const plays = s.plays.map((p) => esc(p.title)).join(" + ");
  return `
<tr><td style="padding:16px 0;border-top:1px solid #e5e7eb">
  <div style="font-size:16px;font-weight:600">${i + 1}. <a href="https://${esc(a.domain)}" style="color:#111827;text-decoration:none">${esc(a.name ?? a.domain)}</a>
    <span style="font-weight:400;color:#6b7280;font-size:13px">${esc(a.domain)}${facts ? ` · ${esc(facts)}` : ""}</span></div>
  ${plays ? `<div style="margin-top:4px;font-size:13px"><span style="background:#eef2ff;color:#3730a3;padding:2px 8px;border-radius:10px">${plays}</span>${s.lane === "fast" ? ` <span style="background:#fef3c7;color:#92400e;padding:2px 8px;border-radius:10px">single-source</span>` : ""}</div>` : ""}
  <ul style="margin:8px 0 0 18px;padding:0;font-size:14px;color:#111827">${why}</ul>
  ${play ? `<div style="margin-top:8px;font-size:14px;color:#374151"><b>Angle:</b> ${esc(play.angle)}</div>` : ""}
  <div style="margin-top:6px;font-size:12px;color:#9ca3af">priority ${s.priority.toFixed(2)} · intent ${pct(s.intent)} · fit ${pct(s.fit)} · timing ${pct(s.timing)}</div>
</td></tr>`;
}

function leadText(l: Lead, i: number): string {
  const a = l.account, s = l.score;
  return [
    `${i + 1}. ${a.name ?? a.domain} (${a.domain}) ${[a.sizeBand, a.segment, a.region].filter(Boolean).join(", ")}`,
    s.plays.length ? `   Plays: ${s.plays.map((p) => p.title).join(" + ")}${s.lane === "fast" ? " [single-source]" : ""}` : "",
    ...s.drivers.slice(0, 4).map((e) => `   - ${describe(e)}  ${e.url}`),
    s.plays[0] ? `   Angle: ${s.plays[0].angle}` : "",
    `   priority ${s.priority.toFixed(2)} | intent ${pct(s.intent)} | fit ${pct(s.fit)} | timing ${pct(s.timing)}`,
  ].filter(Boolean).join("\n");
}

export function renderDigest(r: ScoreRunResult, pack: Pack, health: DigestHealth, date: string): DigestEmail {
  const leads = r.ranking.leads, watch = r.ranking.watchlist, people = r.personLeads;
  const subject = leads.length
    ? `${leads.length} lead${leads.length === 1 ? "" : "s"} for ${date}: ${leads.slice(0, 3).map((l) => l.account.name ?? l.account.domain).join(", ")}`
    : `No new leads for ${date}`;

  const healthLines = [
    `Job boards checked in the last 24h: ${health.boardsChecked24h} of ${health.boardsTotal}${health.boardsFailing ? ` (${health.boardsFailing} failing)` : ""}`,
    `30-minute ticks in the last 24h: ${health.ticks24h}${health.tickErrors24h ? ` (${health.tickErrors24h} with errors)` : ""}${health.ticks24h < 40 ? " (expected about 48: check the schedule)" : ""}`,
    `Haiku spend today: $${health.haikuTodayUsd.toFixed(3)} of $${health.haikuCapUsd} cap`,
    `Accounts scored: ${r.scored} · held back (source outage): ${r.ranking.held.incomplete} · already sent recently: ${r.ranking.held.recentlyDelivered}`,
    `Config: ${r.configVersion}`,
  ];

  const watchHtml = watch.length
    ? `<h3 style="font-size:15px;margin:24px 0 4px">Watchlist</h3><ul style="margin:0 0 0 18px;padding:0;font-size:14px">${watch.map((w) =>
        `<li style="margin:4px 0"><a href="https://${esc(w.account.domain)}" style="color:#111827">${esc(w.account.name ?? w.account.domain)}</a> <span style="color:#6b7280">${esc(w.score.drivers[0] ? describe(w.score.drivers[0]) : "")}</span></li>`).join("")}</ul>`
    : "";
  const peopleHtml = people.length
    ? `<h3 style="font-size:15px;margin:24px 0 4px">Person leads (no company yet; reply in the thread)</h3><ul style="margin:0 0 0 18px;padding:0;font-size:14px">${people.map((p) =>
        `<li style="margin:4px 0">${esc(p.platform)}/${esc(p.handle)}: <a href="${esc(p.url)}" style="color:#1a56db">"${esc(p.quote)}"</a></li>`).join("")}</ul>`
    : "";

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f9fafb">
<div style="max-width:680px;margin:0 auto;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;background:#ffffff">
  <div style="font-size:13px;color:#6b7280">${esc(pack.meta.name)} · ${esc(date)}</div>
  <h2 style="font-size:20px;margin:4px 0 4px">${leads.length ? `Top ${leads.length} leads today` : "No leads today"}</h2>
  <div style="font-size:13px;color:#6b7280">Ranked by need now × ICP fit × timing. Month one: trust the order more than the percentages, and label what you see.</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top:8px">${leads.map(leadHtml).join("")}</table>
  ${watchHtml}${peopleHtml}
  <h3 style="font-size:15px;margin:24px 0 4px">Health</h3>
  <ul style="margin:0 0 0 18px;padding:0;font-size:13px;color:#374151">${healthLines.map((h) => `<li style="margin:2px 0">${esc(h)}</li>`).join("")}</ul>
</div></body></html>`;

  const text = [
    `${pack.meta.name} · ${date}`,
    leads.length ? `TOP ${leads.length} LEADS` : "NO LEADS TODAY",
    "",
    ...leads.map((l, i) => leadText(l, i) + "\n"),
    watch.length ? `WATCHLIST\n${watch.map((w) => `- ${w.account.name ?? w.account.domain} (${w.account.domain})`).join("\n")}\n` : "",
    people.length ? `PERSON LEADS\n${people.map((p) => `- ${p.platform}/${p.handle}: "${p.quote}" ${p.url}`).join("\n")}\n` : "",
    "HEALTH",
    ...healthLines.map((h) => `- ${h}`),
  ].join("\n");

  return { subject, html, text };
}
