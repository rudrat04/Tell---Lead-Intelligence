/**
 * One-time: authorise the sending account and store its refresh token in .env.
 * Scopes: gmail.send (digest) + drive.file (only the leads Sheet this app creates).
 * Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (a "Desktop app" OAuth client).
 * The token is written to .env and never printed.
 *   pnpm gmail:auth
 */
import "dotenv/config";
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { GOOGLE_SCOPES } from "@tell/deliver";

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;
if (!clientId || !clientSecret) {
  console.error("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (Google Cloud > APIs & Services > Credentials > OAuth client ID > Desktop app).");
  process.exit(1);
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

function saveToEnv(key: string, value: string) {
  const path = ".env";
  const lines = existsSync(path) ? readFileSync(path, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join("\n"));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
  const code = url.searchParams.get("code");
  if (url.searchParams.get("state") !== state || !code) {
    res.writeHead(400, { "content-type": "text/plain" }).end(`Authorisation failed: ${url.searchParams.get("error") ?? "bad state"}`);
    console.error("Authorisation failed or was cancelled.");
    server.close(); process.exitCode = 1; return;
  }
  const port = (server.address() as { port: number }).port;
  const tok = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `http://127.0.0.1:${port}/callback`, grant_type: "authorization_code", code_verifier: verifier }),
  });
  const j = (await tok.json()) as { refresh_token?: string; scope?: string; error?: string; error_description?: string };
  if (!j.refresh_token) {
    res.writeHead(500, { "content-type": "text/plain" }).end("No refresh token returned. Check the console.");
    console.error(`No refresh token: ${j.error ?? ""} ${j.error_description ?? ""}`.trim());
    server.close(); process.exitCode = 1; return;
  }
  saveToEnv("GMAIL_REFRESH_TOKEN", j.refresh_token);
  res.writeHead(200, { "content-type": "text/plain" }).end("Done. You can close this tab and return to the terminal.");
  console.log(`Saved GMAIL_REFRESH_TOKEN to .env (scopes: ${j.scope}). Next: pnpm sheet:setup`);
  server.close();
});

server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  auth.search = new URLSearchParams({
    client_id: clientId, redirect_uri: `http://127.0.0.1:${port}/callback`, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256",
  }).toString();
  console.log("Opening your browser to authorise sending. Sign in with the sending account (e.g. your Workspace address).");
  console.log(`If it doesn't open, visit:\n${auth.toString()}\n`);
  execFile("open", [auth.toString()], () => {});
});
