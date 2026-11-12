/**
 * Daily digest: score, render, send (once per IST day).
 *   pnpm digest            score + send (counts only in the log: safe for public Actions logs)
 *   pnpm digest --dry      score without writing, save the email to digest-preview.html (local only)
 *   pnpm digest --test     send today's digest now with a [TEST] subject; records nothing (local only)
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { loadPack } from "@tell/config";
import { runDigest, gmailSender } from "@tell/deliver";

const dry = process.argv.includes("--dry");
const test = process.argv.includes("--test");
if ((dry || test) && process.env.CI) {
  console.error("--dry/--test are for local use (lead details); refused in CI");
  process.exit(1);
}

const gmailReady = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GMAIL_REFRESH_TOKEN);
const r = await runDigest({ pack: await loadPack(), sender: gmailReady ? gmailSender : null, dryRun: dry, test });
if (dry && r.email) {
  writeFileSync("digest-preview.html", r.email.html);
  console.log(`dry run: "${r.email.subject}" saved to digest-preview.html`);
}
console.log(`digest: status=${r.status}${r.reason ? ` (${r.reason})` : ""} leads=${r.leads} watchlist=${r.watchlist} person_leads=${r.personLeads}${r.sheet ? ` | sheet: ${r.sheet}` : ""}`);
if (r.status === "skipped" && r.reason?.includes("not set")) process.exit(1);
