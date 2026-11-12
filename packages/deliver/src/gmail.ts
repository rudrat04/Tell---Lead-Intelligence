/**
 * Gmail API sender (send-only scope). Credentials: an OAuth client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) and a
 * refresh token for the sending account (GMAIL_REFRESH_TOKEN), created once with `pnpm gmail:auth`.
 * Behind a small interface so another delivery method can be added later.
 */

export interface Sender {
  send(msg: { from: string; fromName: string; to: string; subject: string; html: string; text: string }): Promise<{ id: string }>;
}

export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export async function googleAccessToken(env = process.env): Promise<string> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error("Gmail needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GMAIL_REFRESH_TOKEN (run pnpm gmail:auth once)");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: GMAIL_REFRESH_TOKEN, grant_type: "refresh_token" }),
  });
  const j = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!j.access_token) throw new Error(`Google token refresh failed: ${j.error ?? res.status} ${j.error_description ?? ""}`.trim());
  return j.access_token;
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** RFC 2047 encoded-word for non-ASCII headers */
const hdr = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** multipart/alternative MIME message (text + html). Exported for tests. */
export function buildMime(m: Parameters<Sender["send"]>[0], boundary = `b_${Date.now().toString(36)}`): string {
  const part = (type: string, body: string) =>
    `--${boundary}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n")}\r\n`;
  return [
    `From: ${hdr(m.fromName)} <${m.from}>`,
    `To: ${m.to}`,
    `Subject: ${hdr(m.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    part("text/plain", m.text) + part("text/html", m.html) + `--${boundary}--`,
  ].join("\r\n");
}

export const gmailSender: Sender = {
  async send(m) {
    const token = await googleAccessToken();
    const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: b64url(buildMime(m)) }),
    });
    const j = (await res.json()) as { id?: string; error?: { message?: string } };
    if (!res.ok || !j.id) throw new Error(`Gmail send failed: ${res.status} ${j.error?.message ?? ""}`.trim());
    return { id: j.id };
  },
};
