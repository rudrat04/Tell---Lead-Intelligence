import { googleAccessToken } from "./gmail.js";

/**
 * Bounce reading (plan 9b): hard bounces in the sending mailbox mark that address invalid, so it is never offered again.
 * Needs the gmail.readonly scope (re-run `pnpm google:auth`). Until then the reader reports "no read scope" and does nothing.
 * Only permanent failures (5.x.x) count; "try again later" (4.x.x) is ignored.
 */

interface Part { mimeType?: string; headers?: { name: string; value: string }[]; body?: { data?: string }; parts?: Part[] }
export interface GmailMessage { id: string; payload?: Part; snippet?: string }

const decode = (d?: string) => (d ? Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "");
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const SENDERS = /mailer-daemon|postmaster|mail delivery (subsystem|system)/i;

function walk(p: Part | undefined, out: Part[] = []): Part[] {
  if (!p) return out;
  out.push(p);
  for (const c of p.parts ?? []) walk(c, out);
  return out;
}

/**
 * Permanently failed recipients in a bounce message. Order of trust: the machine-readable delivery-status report
 * (RFC 3464), then the X-Failed-Recipients header, then Gmail's own "wasn't delivered to" wording.
 */
export function failedRecipients(m: GmailMessage): string[] {
  const parts = walk(m.payload);
  const headers = parts.flatMap((p) => p.headers ?? []);
  const from = headers.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  if (!SENDERS.test(from)) return [];
  const out = new Set<string>();

  for (const p of parts.filter((x) => x.mimeType === "message/delivery-status")) {
    // per-recipient blocks are separated by blank lines
    for (const block of decode(p.body?.data).split(/\r?\n\r?\n/)) {
      const rcpt = block.match(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^>\s]+)>?/im)?.[1];
      const action = block.match(/^Action:\s*(\w+)/im)?.[1]?.toLowerCase();
      const status = block.match(/^Status:\s*(\d)\./im)?.[1];
      if (rcpt && action === "failed" && status !== "4") out.add(rcpt.toLowerCase());
    }
  }
  if (out.size) return [...out];

  const xfr = headers.find((h) => h.name.toLowerCase() === "x-failed-recipients")?.value;
  if (xfr) for (const a of xfr.split(/[,\s]+/)) if (EMAIL.test(a)) out.add(a.toLowerCase());
  if (out.size) return [...out];

  const text = [m.snippet ?? "", ...parts.filter((p) => p.mimeType === "text/plain").map((p) => decode(p.body?.data))].join("\n");
  if (/\b(temporar(y|ily)|will retry|try again later|delayed)\b/i.test(text)) return [];
  const hit = text.match(/(?:wasn'?t|was not|couldn'?t be|could not be) delivered to\s+<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
    ?? text.match(/address (?:couldn'?t|could not|wasn'?t) (?:be )?found[^@]{0,120}?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
  if (hit) out.add(hit[1]!.toLowerCase());
  return [...out];
}

export type BounceFetch = { status: "ok"; messages: number; addresses: string[] } | { status: "skipped"; reason: string };

/** Bounce messages from the last `days` days in the sending mailbox. */
export async function fetchBounces(days = 3, env = process.env): Promise<BounceFetch> {
  let token: string;
  try { token = await googleAccessToken(env); } catch (e) { return { status: "skipped", reason: (e as Error).message.slice(0, 120) }; }
  const api = (path: string) => fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` } });
  const q = encodeURIComponent(`from:(mailer-daemon OR postmaster) newer_than:${days}d`);
  const list = await api(`messages?q=${q}&maxResults=100`);
  if (list.status === 403) return { status: "skipped", reason: "no read scope: re-run pnpm google:auth to add gmail.readonly" };
  if (!list.ok) return { status: "skipped", reason: `Gmail list failed: HTTP ${list.status}` };
  const ids = ((await list.json()) as { messages?: { id: string }[] }).messages ?? [];
  const addresses = new Set<string>();
  for (const { id } of ids) {
    const res = await api(`messages/${id}?format=full`);
    if (!res.ok) continue;
    for (const a of failedRecipients((await res.json()) as GmailMessage)) addresses.add(a);
  }
  return { status: "ok", messages: ids.length, addresses: [...addresses] };
}
