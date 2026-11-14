import type { Pack } from "@tell/config";
import { runScoring } from "./score.js";
import { contactsFor } from "./contacts.js";
import { preferredPersonas } from "./reach.js";

export interface BackfillResult { candidates: number; withContact: number; searched: boolean }

/**
 * Weekly: find named contacts (people search, cached 30 days per account + persona) for the accounts that score as
 * eligible today, best first, so the daily digest has someone to name for more of them. Only accounts the pack's
 * hard filters admit are scored (with `regions_any: [India]`, that is India only). Counts only: safe for public logs.
 */
export async function backfillContacts(opts: { pack: Pack; maxAccounts?: number; maxSearches?: number }): Promise<BackfillResult> {
  const { pack } = opts;
  const score = await runScoring({ pack, write: false, maxLeads: 1 });
  const rows = (score.all ?? []).filter((r) => r.score.eligible).sort((a, b) => b.score.priority - a.score.priority).slice(0, opts.maxAccounts ?? 120);
  const ids = rows.map((r) => r.account.id);
  const searched = !!process.env.EXA_API_KEY;
  const contacts = await contactsFor(ids, pack, {
    write: true, searchFor: ids, maxSearches: opts.maxSearches ?? 80, preferred: preferredPersonas(rows.map((r) => ({ ...r, incomplete: false, recentlyDelivered: false, newPlaySinceDelivery: false }))),
  });
  return { candidates: ids.length, withContact: ids.filter((id) => contacts.get(id)).length, searched };
}
