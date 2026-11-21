/** Same-day alerts for the strongest fresh signals with a named contact (pack delivery.alerts). Counts only. pnpm alerts [--dry] */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runAlerts, gmailSender } from "@tell/deliver";
const pack = await loadPack();
const dryRun = process.argv.includes("--dry");
const r = await runAlerts({ pack, sender: process.env.GMAIL_REFRESH_TOKEN ? gmailSender : null, dryRun });
console.log(`alerts${dryRun ? " (dry: nothing sent)" : ""}: candidates=${r.candidates} sent=${r.sent} no_contact=${r.noContact} off_industry=${r.offIndustry ?? 0}${r.skipped ? ` (${r.skipped})` : ""}`);
