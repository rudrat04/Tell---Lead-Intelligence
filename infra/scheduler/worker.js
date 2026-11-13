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
 */

// cron expression (UTC) -> workflow file to dispatch
import { sign } from "./sign.js";

const SCHEDULE = {
  "*/30 * * * *": "tick.yml",    // every 30 minutes
  "0 2 * * *": "daily.yml",      // 07:30 IST: boards, gigs, scoring, digest
  "15 22 * * 6": "boards.yml",   // Sunday 03:45 IST: weekly discovery
};

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

async function labels(request, env) {
  const url = new URL(request.url);
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
    ctx.waitUntil(dispatch(env, workflow));
  },
  // Visiting the Worker URL shows only that it is alive (no dispatch, nothing secret).
  async fetch(request, env) {
    const r = request ? await labels(request, env) : null;
    if (r) return r;
    return new Response(`tell-scheduler: ${Object.keys(SCHEDULE).length} schedules\n`, { headers: { "content-type": "text/plain" } });
  },
};
