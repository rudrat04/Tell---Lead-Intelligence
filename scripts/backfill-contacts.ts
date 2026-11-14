/**
 * Weekly contact backfill: people search for the best eligible accounts, so the digest can name someone for more of them.
 *   pnpm contacts:backfill [maxSearches]   (needs EXA_API_KEY; counts only: safe for public Actions logs)
 */
import "dotenv/config";
import { loadPack } from "@tell/config";
import { backfillContacts } from "@tell/pipeline";

const maxSearches = Number(process.argv[2]) || undefined;
const r = await backfillContacts({ pack: await loadPack(), maxSearches });
console.log(`contacts backfill: candidates=${r.candidates} with_contact=${r.withContact} ${r.searched ? "" : "(EXA_API_KEY not set: only YC founders refreshed)"}`.trim());
