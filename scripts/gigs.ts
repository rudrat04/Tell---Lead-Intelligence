/** Fetch freelance/contract gigs matching the pack. Counts only (public logs). pnpm gigs */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { runGigs } from "@tell/pipeline";

const r = await runGigs({ pack: await loadPack() });
const fetched = Object.entries(r.fetched).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
const errors = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(" | ");
console.log(`gigs: fetched ${fetched} matched=${r.matched} added=${r.added} removed_expired=${r.removedExpired}${errors ? ` ERRORS ${errors}` : ""}`);
if (Object.keys(r.fetched).length === 0 && Object.keys(r.errors).length > 0) process.exit(1);
