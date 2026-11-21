/** Minimal robots.txt support (plan 5d: robots.txt respected). Longest-match Allow/Disallow, `*` and `$` wildcards. */

import { botToken, userAgent } from "./identity.js";

interface Rule { allow: boolean; pattern: string }

export function parseRobots(txt: string, agentToken = botToken()): Rule[] {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let cur: { agents: string[]; rules: Rule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!.toLowerCase(), val = m[2]!.trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && cur) {
      lastWasAgent = false;
      if (key === "disallow" && val === "") continue; // empty Disallow = allow all
      cur.rules.push({ allow: key === "allow", pattern: val });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agentToken.toLowerCase().includes(a)));
  return (mine.length ? mine : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
}

/**
 * robots.txt wildcard match (`*` = any run, trailing `$` = end), without regular expressions: a pattern of many stars
 * ("*****.../alerts$", seen on a real site) turned into `.*.*.*...` backtracks exponentially and froze discovery for
 * 15 minutes. Greedy two-pointer glob match: linear in practice, never exponential. Exported for tests.
 */
export function robotsMatch(pattern: string, path: string): boolean {
  let p = pattern.replace(/\*+/g, "*");
  const anchored = p.endsWith("$");
  if (anchored) p = p.slice(0, -1);
  // without `$`, the pattern only has to match a prefix of the path: same as a trailing star
  if (!anchored && !p.endsWith("*")) p += "*";
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < path.length) {
    if (i < p.length && p[i] !== "*" && p[i] === path[j]) { i++; j++; }
    else if (i < p.length && p[i] === "*") { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

export function isPathAllowed(rules: Rule[], path: string): boolean {
  let best: Rule | null = null;
  for (const r of rules) {
    if (!robotsMatch(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return best ? best.allow : true;
}

const cache = new Map<string, Promise<Rule[]>>();

/** Fetches and caches robots.txt per origin. Unreachable/4xx robots.txt = allowed (standard behaviour). */
export async function robotsAllows(url: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const u = new URL(url);
  let rules = cache.get(u.origin);
  if (!rules) {
    rules = fetchImpl(`${u.origin}/robots.txt`, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(8_000) })
      .then(async (r) => (r.ok ? parseRobots(await r.text()) : []))
      .catch(() => []);
    cache.set(u.origin, rules);
  }
  return isPathAllowed(await rules, u.pathname + u.search);
}
