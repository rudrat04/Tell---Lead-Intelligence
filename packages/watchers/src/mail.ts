import { robotsAllows } from "./robots.js";
import { userAgent } from "./identity.js";

/**
 * Public inputs for the email engine (plan 9b): MX records over DNS-over-HTTPS, addresses the company publishes
 * on its own site, and author addresses in its GitHub org's public commits. Nothing is probed over SMTP.
 */

/** MX hosts for a domain. [] = no MX or a null MX ("0 ."), i.e. does not receive mail; null = lookup failed. */
export async function fetchMxHosts(domain: string, timeoutMs = 10_000): Promise<string[] | null> {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`, {
      headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { Status: number; Answer?: { type: number; data: string }[] };
    if (j.Status === 3) return []; // NXDOMAIN
    if (j.Status !== 0) return null;
    return (j.Answer ?? []).filter((a) => a.type === 15)
      .map((a) => a.data.trim().split(/\s+/)[1]?.replace(/\.$/, "") ?? "")
      .filter((h) => h.length > 0); // null MX "0 ." becomes "" and is dropped
  } catch {
    return null;
  }
}

/** Pages where companies list people and mailboxes. Robots.txt respected; missing pages are skipped. */
export const SITE_MAIL_PATHS = ["/", "/contact", "/about", "/team", "/press"];

export async function fetchSitePages(domain: string, paths = SITE_MAIL_PATHS, timeoutMs = 8_000): Promise<{ url: string; text: string }[]> {
  const out: { url: string; text: string }[] = [];
  for (const p of paths) {
    const url = `https://${domain}${p}`;
    try {
      if (!(await robotsAllows(url))) continue;
      const res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      // only pages still on the same site (no redirects off to a hosted page builder or a parent brand)
      const host = new URL(res.url).hostname.replace(/^www\./, "");
      if (host !== domain && !host.endsWith(`.${domain}`)) continue;
      out.push({ url: res.url, text: (await res.text()).slice(0, 1_000_000) });
    } catch { /* unreachable: skip */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return out;
}

const gh = (path: string, timeoutMs: number) => fetch(`https://api.github.com${path}`, {
  headers: {
    "user-agent": userAgent(), accept: "application/vnd.github+json",
    ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  },
  signal: AbortSignal.timeout(timeoutMs),
});

/**
 * Commit author addresses on `domain` from the public repos of the GitHub org whose profile links to that domain.
 * Never guess: the org is tried only under candidate logins, and accepted only if its own `blog` field is the domain.
 */
export async function fetchGithubOrgAddresses(domain: string, candidates: string[], timeoutMs = 10_000): Promise<{ address: string; name: string | null; sourceUrl: string }[]> {
  for (const login of [...new Set(candidates.map((c) => c.toLowerCase().replace(/[^a-z0-9-]/g, "")).filter((c) => c.length >= 2))]) {
    try {
      const org = await gh(`/orgs/${login}`, timeoutMs);
      if (!org.ok) continue;
      const o = (await org.json()) as { blog?: string | null; login: string };
      const blog = (o.blog ?? "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
      if (blog !== domain.toLowerCase()) continue;
      const reposRes = await gh(`/orgs/${o.login}/repos?type=public&sort=pushed&per_page=5`, timeoutMs);
      if (!reposRes.ok) return [];
      const repos = (await reposRes.json()) as { name: string; fork: boolean }[];
      const out = new Map<string, { address: string; name: string | null; sourceUrl: string }>();
      for (const r of repos.filter((x) => !x.fork).slice(0, 3)) {
        const cRes = await gh(`/repos/${o.login}/${r.name}/commits?per_page=50`, timeoutMs);
        if (!cRes.ok) continue;
        const commits = (await cRes.json()) as { html_url: string; commit: { author?: { name?: string; email?: string } } }[];
        for (const c of commits) {
          const email = c.commit.author?.email?.toLowerCase();
          if (email?.endsWith(`@${domain.toLowerCase()}`) && !out.has(email)) out.set(email, { address: email, name: c.commit.author?.name ?? null, sourceUrl: c.html_url });
        }
      }
      return [...out.values()];
    } catch { /* rate-limited or down: try the next login, else nothing */ }
  }
  return [];
}
