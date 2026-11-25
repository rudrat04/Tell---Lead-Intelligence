import { createHmac, randomUUID } from "node:crypto";

/**
 * One-tap Good/Bad links in the digest (served by the Cloudflare Worker in infra/scheduler).
 * Needs TELL_LABEL_URL (the Worker's URL) and LABEL_SECRET (same value as the Worker's secret). Without both, no buttons.
 */
export interface LabelLinks { good: string; bad: string }

/** The day a link was issued (days since 1970, UTC): links carry it as `t`, the signature covers it, and the Worker
 *  accepts a link for LINK_DAYS (45) after it. A leaked link stops working on its own. */
export const issueDay = (now = new Date()) => Math.floor(now.getTime() / 86_400_000);
/** hex HMAC-SHA256 of "<delivery id>|<action>|<issue day>", first 32 chars (same as the Worker's sign.js) */
const sig = (secret: string, deliveryId: string, action: string, t: number) => createHmac("sha256", secret).update(`${deliveryId}|${action}|${t}`).digest("hex").slice(0, 32);
/** The bearer the jobs send to the Worker's read endpoints: JOB_SECRET, its own secret (LABEL_SECRET only signs links);
 *  LABEL_SECRET until JOB_SECRET is set. */
export const jobBearer = (secret: string) => `Bearer ${process.env.JOB_SECRET || secret}`;

export const signLabel = (secret: string, deliveryId: string, label: "good" | "bad", t = issueDay()) => sig(secret, deliveryId, label, t);

export function labelLinks(baseUrl: string, secret: string, deliveryId: string): LabelLinks {
  const base = baseUrl.replace(/\/+$/, "");
  const t = issueDay();
  const link = (v: "good" | "bad") => `${base}/l?d=${deliveryId}&v=${v}&t=${t}&s=${signLabel(secret, deliveryId, v, t)}`;
  return { good: link("good"), bad: link("bad") };
}

/** Delivery ids assigned before rendering, so each lead's links point at the row recorded after the send. */
export function assignDeliveryIds(accountIds: string[]): Map<string, string> {
  return new Map(accountIds.map((a) => [a, randomUUID()]));
}

export interface Tap { d: string; v: "good" | "bad"; at: string }

/** Tell the Worker these taps are stored, so it deletes them. */
export async function ackTaps(baseUrl: string, secret: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/taps/ack`, { method: "POST", headers: { authorization: jobBearer(secret), "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`taps ack: HTTP ${res.status}`);
}

/** Taps waiting in the Worker. Throws on auth or network failure. */
export async function fetchTaps(baseUrl: string, secret: string): Promise<Tap[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/taps`, { headers: { authorization: jobBearer(secret) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`taps: HTTP ${res.status}`);
  const j = (await res.json()) as Tap[];
  return j.filter((t) => /^[0-9a-f-]{36}$/i.test(t.d) && (t.v === "good" || t.v === "bad"));
}

/** Find-email link (the Worker's /e): queues one email lookup for this delivery's people, only when clicked. */
export function enrichLink(baseUrl: string, secret: string, deliveryId: string): string {
  const t = issueDay();
  return `${baseUrl.replace(/\/+$/, "")}/e?d=${deliveryId}&t=${t}&s=${sig(secret, deliveryId, "enrich", t)}`;
}

/** Find-email link for the people at the signal's company (its own signature: a contact link can't ask for it). */
export function enrichSignalLink(baseUrl: string, secret: string, deliveryId: string): string {
  const t = issueDay();
  return `${baseUrl.replace(/\/+$/, "")}/e?d=${deliveryId}&t=${t}&s=${sig(secret, deliveryId, "enrich-signal", t)}&side=signal`;
}

/** person / signal: which side was asked for (older entries carry neither: the contact) */
export interface EnrichRequest { d: string; at: string; person?: boolean; signal?: boolean }

/** Find-email clicks waiting in the Worker. Throws on auth or network failure. */
export async function fetchEnrichRequests(baseUrl: string, secret: string): Promise<EnrichRequest[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/enrich-requests`, { headers: { authorization: jobBearer(secret) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`enrich requests: HTTP ${res.status}`);
  return ((await res.json()) as EnrichRequest[]).filter((r) => /^[0-9a-f-]{36}$/i.test(r.d));
}

export async function ackEnrichRequests(baseUrl: string, secret: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/enrich-requests/ack`, { method: "POST", headers: { authorization: jobBearer(secret), "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`enrich requests ack: HTTP ${res.status}`);
}

/** Create-draft link (the Worker's /cd): queues one draft for this delivery, written only when clicked (saves tokens). */
export function draftLink(baseUrl: string, secret: string, deliveryId: string): string {
  const t = issueDay();
  return `${baseUrl.replace(/\/+$/, "")}/cd?d=${deliveryId}&t=${t}&s=${sig(secret, deliveryId, "draft", t)}`;
}

/** Create-draft clicks waiting in the Worker (Telegram "Create draft" or the Sheet link). */
export async function fetchDraftRequests(baseUrl: string, secret: string): Promise<EnrichRequest[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/draft-requests`, { headers: { authorization: jobBearer(secret) }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`draft requests: HTTP ${res.status}`);
  return ((await res.json()) as EnrichRequest[]).filter((r) => /^[0-9a-f-]{36}$/i.test(r.d));
}

export async function ackDraftRequests(baseUrl: string, secret: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/draft-requests/ack`, { method: "POST", headers: { authorization: jobBearer(secret), "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`draft requests ack: HTTP ${res.status}`);
}
