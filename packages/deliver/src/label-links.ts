import { createHmac, randomUUID } from "node:crypto";

/**
 * One-tap Good/Bad links in the digest (served by the Cloudflare Worker in infra/scheduler).
 * Needs TELL_LABEL_URL (the Worker's URL) and LABEL_SECRET (same value as the Worker's secret). Without both, no buttons.
 */
export interface LabelLinks { good: string; bad: string }

export const signLabel = (secret: string, deliveryId: string, label: "good" | "bad") =>
  createHmac("sha256", secret).update(`${deliveryId}|${label}`).digest("hex").slice(0, 32);

export function labelLinks(baseUrl: string, secret: string, deliveryId: string): LabelLinks {
  const base = baseUrl.replace(/\/+$/, "");
  const link = (v: "good" | "bad") => `${base}/l?d=${deliveryId}&v=${v}&s=${signLabel(secret, deliveryId, v)}`;
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
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/taps/ack`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`taps ack: HTTP ${res.status}`);
}

/** Taps waiting in the Worker. Throws on auth or network failure. */
export async function fetchTaps(baseUrl: string, secret: string): Promise<Tap[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/taps`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`taps: HTTP ${res.status}`);
  const j = (await res.json()) as Tap[];
  return j.filter((t) => /^[0-9a-f-]{36}$/i.test(t.d) && (t.v === "good" || t.v === "bad"));
}

/** Find-email link (the Worker's /e): queues one Air Waterfall lookup for this delivery's contact, only when clicked. */
export function enrichLink(baseUrl: string, secret: string, deliveryId: string): string {
  const sig = createHmac("sha256", secret).update(`${deliveryId}|enrich`).digest("hex").slice(0, 32);
  return `${baseUrl.replace(/\/+$/, "")}/e?d=${deliveryId}&s=${sig}`;
}

export interface EnrichRequest { d: string; at: string }

/** Find-email clicks waiting in the Worker. Throws on auth or network failure. */
export async function fetchEnrichRequests(baseUrl: string, secret: string): Promise<EnrichRequest[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/enrich-requests`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`enrich requests: HTTP ${res.status}`);
  return ((await res.json()) as EnrichRequest[]).filter((r) => /^[0-9a-f-]{36}$/i.test(r.d));
}

export async function ackEnrichRequests(baseUrl: string, secret: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/enrich-requests/ack`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`enrich requests ack: HTTP ${res.status}`);
}

/** Create-draft link (the Worker's /cd): queues one draft for this delivery, written only when clicked (saves tokens). */
export function draftLink(baseUrl: string, secret: string, deliveryId: string): string {
  const sig = createHmac("sha256", secret).update(`${deliveryId}|draft`).digest("hex").slice(0, 32);
  return `${baseUrl.replace(/\/+$/, "")}/cd?d=${deliveryId}&s=${sig}`;
}

/** Create-draft clicks waiting in the Worker (Telegram "Create draft" or the Sheet link). */
export async function fetchDraftRequests(baseUrl: string, secret: string): Promise<EnrichRequest[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/draft-requests`, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`draft requests: HTTP ${res.status}`);
  return ((await res.json()) as EnrichRequest[]).filter((r) => /^[0-9a-f-]{36}$/i.test(r.d));
}

export async function ackDraftRequests(baseUrl: string, secret: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/draft-requests/ack`, { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" }, body: JSON.stringify(ids), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`draft requests ack: HTTP ${res.status}`);
}
