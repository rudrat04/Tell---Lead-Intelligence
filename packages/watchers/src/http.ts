import { createHash } from "node:crypto";

import { userAgent } from "./identity.js";
const lastHit = new Map<string, number>();

/** Per-host rate limit: min gap between requests to the same host. */
export async function politeGet(url: string, minGapMs = 1000): Promise<string> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  // 429/503 are the host asking us to slow down: honour Retry-After (capped) and try again, twice
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      // a timeout or dropped connection is usually momentary (the HN API does this a few times a day): one more try
      if (attempt < 1) { await new Promise((r) => setTimeout(r, 2_000)); lastHit.set(host, Date.now()); continue; }
      throw e;
    }
    if (res.ok) return res.text();
    if ((res.status === 429 || res.status === 503) && attempt < 2) {
      const ra = Number(res.headers.get("retry-after"));
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5_000 * 2 ** attempt, 60_000)));
      lastHit.set(host, Date.now());
      continue;
    }
    throw new Error(`GET ${url} -> ${res.status}`);
  }
}

export async function getJson<T = unknown>(url: string, minGapMs?: number): Promise<T> {
  return JSON.parse(await politeGet(url, minGapMs)) as T;
}

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");
