/**
 * External scheduler for Tell (Cloudflare Workers free plan).
 * GitHub's own cron is unreliable (runs are delayed or skipped), so this Worker calls the
 * GitHub "workflow_dispatch" API on time. It does no other work.
 *
 * Free-plan fit: 3 cron triggers (limit 5 per account), ~50 invocations/day (limit 100,000),
 * 1 subrequest each (limit 50), negligible CPU (waiting on fetch doesn't count).
 *
 * Secrets / vars (set in the Cloudflare dashboard or with wrangler):
 *   GH_TOKEN      (secret)  fine-grained GitHub token: this repository only, "Actions: Read and write"
 *   GH_REPO       (var)     e.g. "owner/repo"
 *   LABEL_SECRET  (secret)  shared with the digest (GitHub secret of the same name): signs the Good/Bad links
 *   LABELS        (KV)      where taps wait until the daily sync collects them
 *
 * One-tap labels: the digest links to /l?d=<delivery id>&v=good|bad&s=<signature>. Opening it shows a confirm page
 * (email link scanners prefetch GETs, so a GET never labels); the button POSTs, and the tap is stored in KV.
 * The daily sync reads /taps with the secret as a bearer token. No database credentials live here.
 *
 * Find-email on click: the digest and the Sheet link to /e?d=<delivery id>&s=<signature of "<id>|enrich">. The confirm
 * page's button POSTs; the request is queued in KV ("enrich:<id>") and enrich.yml is dispatched at once, which runs the
 * person through Air Waterfall and writes the answer into the Sheet. Nothing is enriched without that click.
 * The job reads /enrich-requests (and acks them) with the secret as a bearer token.
 *
 * Telegram (when the digest's channels include it): Telegram calls POST /tg for button taps (setWebhook with
 * secret_token = TG_WEBHOOK_SECRET; requests without that header are refused, and only TELEGRAM_CHAT_ID is served).
 *   g:<id> / b:<id>  label good / bad (stored as tap:<id>, exactly like the email links)
 *   e:<id>           find email (queued as enrich:<id>, enrich.yml dispatched, as the email button)
 *   es:<id>          find the emails of the people at the signal's company (the same entry, with signal: true)
 *   cd:<id>          create draft (queued as draft:<id>, drafts.yml dispatched; the Sheet's /cd link does the same)
 *   br:<id> / dr:<id> send the brief / the email draft, which the digest stored with POST /tg-store (bearer LABEL_SECRET)
 * Extra secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TG_WEBHOOK_SECRET.
 */

// cron expression (UTC) -> workflow file to dispatch
import { sign } from "./sign.js";

const SCHEDULE = {
  "*/30 * * * *": "tick.yml",    // every 30 minutes
  "0 2 * * *": "daily.yml",      // 07:30 IST: boards, gigs, scoring, digest
  "15 22 * * 5": "boards.yml",   // Saturday 03:45 IST: weekly discovery
};

/** No scheduled runs on Sunday in India (IST = UTC+5:30). Clicks (Find email, Create draft) still run: you asked for them. */
export const isSundayIst = (d = new Date()) => new Date(d.getTime() + 330 * 60_000).getUTCDay() === 0;

async function dispatch(env, workflow) {
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${workflow}/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "tell-scheduler",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (res.status !== 204) throw new Error(`dispatch ${workflow} failed: HTTP ${res.status} ${await res.text()}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LABELS = new Set(["good", "bad"]);
const page = (title, body, status = 200) => new Response(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:420px;margin:48px auto;padding:0 16px;color:#111827">${body}</body>`,
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", "referrer-policy": "no-referrer" } });

function sameText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
async function valid(env, d, v, s) {
  return !!env.LABEL_SECRET && UUID.test(d ?? "") && LABELS.has(v) && sameText(s, await sign(env.LABEL_SECRET, d, v));
}

/** side "signal" = the people at the signal's company (its own signature, so a contact link can't ask for it) */
async function validEnrich(env, d, s, side = "person") {
  return !!env.LABEL_SECRET && UUID.test(d ?? "") && sameText(s, await sign(env.LABEL_SECRET, d, side === "signal" ? "enrich-signal" : "enrich"));
}

async function validDraft(env, d, s) {
  return !!env.LABEL_SECRET && UUID.test(d ?? "") && sameText(s, await sign(env.LABEL_SECRET, d, "draft"));
}

/** Read or ack queued requests ("<prefix>:<delivery id>" keys) for a job holding the secret. */
async function queue(request, env, prefix) {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/ack")) {
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    const ids = ((await request.json().catch(() => [])) ?? []).filter((d) => typeof d === "string" && UUID.test(d)).slice(0, 1000);
    for (const d of ids) await env.LABELS.delete(`${prefix}:${d}`);
    return Response.json({ deleted: ids.length });
  }
  const out = [];
  let cursor;
  do {
    const list = await env.LABELS.list({ prefix: `${prefix}:`, cursor });
    for (const k of list.keys) { const v = await env.LABELS.get(k.name, "json"); if (v) out.push({ d: k.name.slice(prefix.length + 1), ...v }); }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
  return Response.json(out, { headers: { "cache-control": "no-store" } });
}

async function enrich(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const d = url.searchParams.get("d"), s = url.searchParams.get("s"), side = url.searchParams.get("side") === "signal" ? "signal" : "person";
    if (!(await validEnrich(env, d, s, side))) return page("Link not valid", "<p>This link isn't valid.</p>", 400);
    return page("Find email", `<p>${side === "signal" ? "Find the work emails of the people on the signal's side?" : "Find this person's work email?"}</p><p style="color:#6b7280;font-size:14px">Runs the email waterfall once (free checks first, then finders that bill only on a find). Only a verified address is written.</p>
<form method="post" action="/e"><input type="hidden" name="d" value="${d}"><input type="hidden" name="s" value="${s}"><input type="hidden" name="side" value="${side}">
<button style="font-size:18px;padding:12px 24px;border-radius:8px;border:0;background:#1d4ed8;color:#fff">Find email</button></form>`);
  }
  if (request.method === "POST") {
    const f = await request.formData();
    const d = f.get("d"), s = f.get("s"), side = f.get("side") === "signal" ? "signal" : "person";
    if (!(await validEnrich(env, d, s, side))) return page("Link not valid", "<p>This link isn't valid.</p>", 400);
    // one dispatch per minute at most: a run processes every queued request
    await queueEnrich(env, ctx, d, side);
    return page("Finding email", "<p>Finding the email now. It appears in your Sheet's <b>Enrich email</b> column in about 2 minutes.</p>");
  }
  return new Response("method not allowed", { status: 405 });
}

const tgApi = (env, method, body) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Queue a find-email request and dispatch enrich.yml at most once a minute (shared by the email link and Telegram). */
async function queueEnrich(env, ctx, d, side = "person") {
  // one entry per delivery, with the sides asked for (the contact, the signal's people, or both)
  const prior = (await env.LABELS.get(`enrich:${d}`, "json")) ?? {};
  await env.LABELS.put(`enrich:${d}`, JSON.stringify({ ...prior, at: new Date().toISOString(), [side]: true }), { expirationTtl: 60 * 60 * 24 * 7 });
  const last = await env.LABELS.get("enrich-dispatched-at");
  if (!last || Date.now() - Number(last) > 60_000) {
    await env.LABELS.put("enrich-dispatched-at", String(Date.now()), { expirationTtl: 3600 });
    ctx?.waitUntil(dispatch(env, "enrich.yml").catch(() => { /* the daily run picks the request up */ }));
  }
}

/** Queue a create-draft request and dispatch drafts.yml at most once a minute (Telegram "Create draft" and the Sheet link).
 *  Drafts are written only on a click, so no tokens go to leads you never write to. */
async function queueDraft(env, ctx, d) {
  await env.LABELS.put(`draft:${d}`, JSON.stringify({ at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 7 });
  const last = await env.LABELS.get("draft-dispatched-at");
  if (!last || Date.now() - Number(last) > 60_000) {
    await env.LABELS.put("draft-dispatched-at", String(Date.now()), { expirationTtl: 3600 });
    ctx?.waitUntil(dispatch(env, "drafts.yml").catch(() => { /* the daily run picks the request up */ }));
  }
}

async function createDraft(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET") {
    const d = url.searchParams.get("d"), s = url.searchParams.get("s");
    if (!(await validDraft(env, d, s))) return page("Link not valid", "<p>This link isn't valid.</p>", 400);
    return page("Create draft", `<p>Write the opening email for this lead?</p><p style="color:#6b7280;font-size:14px">One draft, checked against the lead's facts. It replaces this link in your Sheet's <b>Email draft</b> column.</p>
<form method="post" action="/cd"><input type="hidden" name="d" value="${d}"><input type="hidden" name="s" value="${s}">
<button style="font-size:18px;padding:12px 24px;border-radius:8px;border:0;background:#1d4ed8;color:#fff">Create draft</button></form>`);
  }
  if (request.method === "POST") {
    const f = await request.formData();
    const d = f.get("d"), s = f.get("s");
    if (!(await validDraft(env, d, s))) return page("Link not valid", "<p>This link isn't valid.</p>", 400);
    await queueDraft(env, ctx, d);
    return page("Writing the draft", "<p>Writing it now. It appears in your Sheet's <b>Email draft</b> column (and on Telegram) in about 2 minutes.</p>");
  }
  return new Response("method not allowed", { status: 405 });
}

/** Telegram cuts a message at 4,096 characters: send long text in parts, split at lines. */
function tgParts(text, max = 4000) {
  const out = []; let cur = "";
  for (const line of String(text).split("\n")) { if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ""; } cur = cur ? `${cur}\n${line}` : line.slice(0, max); }
  if (cur) out.push(cur);
  return out;
}

async function telegram(request, env, ctx) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.TG_WEBHOOK_SECRET || !sameText(request.headers.get("x-telegram-bot-api-secret-token") ?? "", env.TG_WEBHOOK_SECRET)) return new Response("forbidden", { status: 403 });
  const update = await request.json().catch(() => null);
  const q = update?.callback_query;
  if (!q) return Response.json({ ok: true });
  const chat = String(q.message?.chat?.id ?? "");
  if (!env.TELEGRAM_CHAT_ID || chat !== String(env.TELEGRAM_CHAT_ID)) return Response.json({ ok: true }); // not your chat: ignored
  const [op, d] = String(q.data ?? "").split(":");
  let answer = "Unknown button";
  if (UUID.test(d ?? "")) {
    if (op === "g" || op === "b") {
      const v = op === "g" ? "good" : "bad";
      await env.LABELS.put(`tap:${d}`, JSON.stringify({ v, at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 30 });
      answer = v === "good" ? "Saved 👍 (reaches your Sheet with the next sync)" : "Saved 👎 (reaches your Sheet with the next sync)";
    } else if (op === "e") {
      await queueEnrich(env, ctx, d);
      answer = "Finding the email: it appears in your Sheet in about 2 minutes";
    } else if (op === "es") {
      await queueEnrich(env, ctx, d, "signal");
      answer = "Finding the signal side's emails: the answer arrives here in about 2 minutes";
    } else if (op === "cd") {
      await queueDraft(env, ctx, d);
      answer = "Writing the draft: it arrives here in about 2 minutes";
    } else if (op === "br" || op === "dr") {
      const t = await env.LABELS.get(`tgtext:${d}`, "json");
      const text = op === "br" ? t?.brief : t?.draft;
      if (text) { for (const part of tgParts(text)) await tgApi(env, "sendMessage", { chat_id: chat, text: part, disable_web_page_preview: true, reply_to_message_id: q.message?.message_id }); answer = "Sent below"; }
      else answer = op === "br" ? "No brief for this lead" : "No draft yet: tap Create draft";
    }
  }
  await tgApi(env, "answerCallbackQuery", { callback_query_id: q.id, text: answer });
  return Response.json({ ok: true });
}

/** The digest stores each lead's brief and draft here for the Telegram buttons (bearer LABEL_SECRET, kept 30 days). */
async function tgStore(request, env) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!env.LABEL_SECRET || !sameText(request.headers.get("authorization") ?? "", `Bearer ${env.LABEL_SECRET}`)) return new Response("forbidden", { status: 403 });
  const items = ((await request.json().catch(() => [])) ?? []).filter((x) => x && UUID.test(x.d ?? "")).slice(0, 100);
  for (const x of items) await env.LABELS.put(`tgtext:${x.d}`, JSON.stringify({ brief: typeof x.brief === "string" ? x.brief.slice(0, 20000) : null, draft: typeof x.draft === "string" ? x.draft.slice(0, 8000) : null }), { expirationTtl: 60 * 60 * 24 * 30 });
  return Response.json({ stored: items.length });
}

async function labels(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/tg") return telegram(request, env, ctx);
  if (url.pathname === "/tg-store") return tgStore(request, env);
  if (url.pathname === "/enrich-requests" || url.pathname === "/enrich-requests/ack") {
    if (!env.LABEL_SECRET || !sameText(request.headers.get("authorization") ?? "", `Bearer ${env.LABEL_SECRET}`)) return new Response("forbidden", { status: 403 });
    return queue(request, env, "enrich");
  }
  if (url.pathname === "/e") return enrich(request, env, ctx);
  if (url.pathname === "/cd") return createDraft(request, env, ctx);
  if (url.pathname === "/draft-requests" || url.pathname === "/draft-requests/ack") {
    if (!env.LABEL_SECRET || !sameText(request.headers.get("authorization") ?? "", `Bearer ${env.LABEL_SECRET}`)) return new Response("forbidden", { status: 403 });
    return queue(request, env, "draft");
  }
  if (url.pathname === "/taps" || url.pathname === "/taps/ack") {
    if (!env.LABEL_SECRET || !sameText(request.headers.get("authorization") ?? "", `Bearer ${env.LABEL_SECRET}`)) return new Response("forbidden", { status: 403 });
    if (url.pathname === "/taps/ack") {
      // the sync has stored these taps: delete them so a label you later clear in the Sheet isn't refilled
      if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
      const ids = ((await request.json().catch(() => [])) ?? []).filter((d) => typeof d === "string" && UUID.test(d)).slice(0, 1000);
      for (const d of ids) await env.LABELS.delete(`tap:${d}`);
      return Response.json({ deleted: ids.length });
    }
    const out = [];
    let cursor;
    do {
      const list = await env.LABELS.list({ prefix: "tap:", cursor });
      for (const k of list.keys) { const v = await env.LABELS.get(k.name, "json"); if (v) out.push({ d: k.name.slice(4), ...v }); }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  }
  if (url.pathname !== "/l") return null;
  if (request.method === "GET") {
    const d = url.searchParams.get("d"), v = url.searchParams.get("v"), s = url.searchParams.get("s");
    if (!(await valid(env, d, v, s))) return page("Link not valid", "<p>This label link isn't valid.</p>", 400);
    return page("Label this lead", `<p>Mark this lead as <b>${v === "good" ? "Good 👍" : "Bad 👎"}</b>?</p>
<form method="post" action="/l"><input type="hidden" name="d" value="${d}"><input type="hidden" name="v" value="${v}"><input type="hidden" name="s" value="${s}">
<button style="font-size:18px;padding:12px 24px;border-radius:8px;border:0;background:${v === "good" ? "#065f46" : "#991b1b"};color:#fff">Yes, ${v}</button></form>`);
  }
  if (request.method === "POST") {
    const f = await request.formData();
    const d = f.get("d"), v = f.get("v"), s = f.get("s");
    if (!(await valid(env, d, v, s))) return page("Link not valid", "<p>This label link isn't valid.</p>", 400);
    await env.LABELS.put(`tap:${d}`, JSON.stringify({ v, at: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 30 });
    return page("Saved", `<p>Saved as <b>${v}</b>. It reaches your Sheet with tomorrow's digest run.</p>`);
  }
  return new Response("method not allowed", { status: 405 });
}

export default {
  async scheduled(event, env, ctx) {
    const workflow = SCHEDULE[event.cron];
    if (!workflow) throw new Error(`no workflow mapped for cron "${event.cron}"`);
    if (isSundayIst(new Date(event.scheduledTime ?? Date.now()))) return; // Sunday (IST): nothing runs
    ctx.waitUntil(dispatch(env, workflow));
  },
  // Visiting the Worker URL shows only that it is alive (no dispatch, nothing secret).
  async fetch(request, env, ctx) {
    const r = request ? await labels(request, env, ctx) : null;
    if (r) return r;
    return new Response(`tell-scheduler: ${Object.keys(SCHEDULE).length} schedules\n`, { headers: { "content-type": "text/plain" } });
  },
};
