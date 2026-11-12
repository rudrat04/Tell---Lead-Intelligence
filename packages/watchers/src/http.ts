import { createHash } from "node:crypto";

import { userAgent } from "./identity.js";
const lastHit = new Map<string, number>();

/** Per-host rate limit: min gap between requests to the same host. */
export async function politeGet(url: string, minGapMs = 1000): Promise<string> {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
  const res = await fetch(url, { headers: { "user-agent": userAgent(), accept: "*/*" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

export async function getJson<T = unknown>(url: string, minGapMs?: number): Promise<T> {
  return JSON.parse(await politeGet(url, minGapMs)) as T;
}

export const contentHash = (s: string) => createHash("sha256").update(s).digest("hex");
