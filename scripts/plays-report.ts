/** What each play and industry delivered and how you labelled it (Sheet Label / Outcome). Counts only. pnpm plays:report [days] */
import "dotenv/config";
import { playReport } from "@tell/pipeline";
const days = Number(process.argv[2] ?? 90);
const rows = await playReport(days);
if (!rows.length) { console.log(`plays report: no deliveries in the last ${days} days`); process.exit(0); }
console.log(`plays report, last ${days} days (label your leads 👍/👎 and set Outcome in the Sheet; pnpm sheet:sync pulls them):`);
console.log(`  ${"play".padEnd(30)} ${"industry".padEnd(20)} sent  👍  👎  replied  meetings  won  verdict`);
for (const r of rows) console.log(`  ${r.play.slice(0, 30).padEnd(30)} ${r.segment.slice(0, 20).padEnd(20)} ${String(r.delivered).padStart(4)} ${String(r.good).padStart(3)} ${String(r.bad).padStart(3)} ${String(r.replied).padStart(8)} ${String(r.meetings).padStart(9)} ${String(r.won).padStart(4)}  ${r.verdict}`);
