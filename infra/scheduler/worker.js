/**
 * External scheduler for Tell (Cloudflare Workers free plan).
 * GitHub's own cron is unreliable (runs are delayed or skipped), so this Worker calls the
 * GitHub "workflow_dispatch" API on time. It does no other work.
 *
 * Free-plan fit: 3 cron triggers (limit 5 per account), ~50 invocations/day (limit 100,000),
 * 1 subrequest each (limit 50), negligible CPU (waiting on fetch doesn't count).
 *
 * Secrets / vars (set in the Cloudflare dashboard or with wrangler):
 *   GH_TOKEN  (secret)  fine-grained GitHub token: this repository only, "Actions: Read and write"
 *   GH_REPO   (var)     e.g. "owner/repo"
 */

// cron expression (UTC) -> workflow file to dispatch
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

export default {
  async scheduled(event, env, ctx) {
    const workflow = SCHEDULE[event.cron];
    if (!workflow) throw new Error(`no workflow mapped for cron "${event.cron}"`);
    ctx.waitUntil(dispatch(env, workflow));
  },
  // Visiting the Worker URL shows only that it is alive (no dispatch, nothing secret).
  async fetch() {
    return new Response(`tell-scheduler: ${Object.keys(SCHEDULE).length} schedules\n`, { headers: { "content-type": "text/plain" } });
  },
};
