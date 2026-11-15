import type { Pack } from "@tell/config";
import { runScoring, contactsFor, analyzeLeads, type ScoredAccount } from "@tell/pipeline";
import type { RankInput } from "@tell/intel";
import { getDb, deliveries, eq, sql } from "@tell/db";
import { emailDraft, linkedinDraft, leadOpener } from "./render.js";
import { ensureLeadHeaders, fillColumnById, LEAD_COLUMNS, LEAD_CELLS_BEFORE_ID } from "./sheets.js";

export interface BackfillDraftsResult {
  deliveries: number;
  scored: number;
  analyst: { fresh: number; cached: number; failed: number; spentUsd: number; skipped?: string };
  drafts: { email: number; linkedin: number };
  sheet: { email: number; opener: number; linkedin: number } | null;
  /** local review only (never printed in CI) */
  samples: { company: string; email: string; linkedin: string }[];
}

/** where a Sheet column sits in the stored row (cells before the hidden ID, then the ones after it) */
const storedIndex = (c: (typeof LEAD_COLUMNS)[number]) => { const i = LEAD_COLUMNS.indexOf(c); return i < LEAD_CELLS_BEFORE_ID ? i : i - 1; };

/**
 * Re-write the opener, email draft and LinkedIn message for leads already delivered, with the current copy brief:
 * re-scores their evidence (no writes), finds their known contacts (no people search), runs the analyst (cached by
 * evidence + prompt, so only a changed brief costs anything), then updates the stored rows and the Sheet. Draft
 * columns are code-owned and overwritten; your Label / Reason / Outcome / Notes are never touched.
 */
export async function backfillDrafts(opts: { pack: Pack; dryRun?: boolean; capUsd?: number }): Promise<BackfillDraftsResult> {
  const { pack } = opts;
  const db = getDb();
  const rows = await db.select({ id: deliveries.id, accountId: deliveries.accountId, row: deliveries.sheetRow }).from(deliveries)
    .where(sql`${deliveries.sheetRow} is not null and ${deliveries.accountId} is not null`);
  const res: BackfillDraftsResult = { deliveries: rows.length, scored: 0, analyst: { fresh: 0, cached: 0, failed: 0, spentUsd: 0 }, drafts: { email: 0, linkedin: 0 }, sheet: null, samples: [] };
  if (!rows.length) return res;

  // latest delivery per account (an account delivered twice gets the same drafts on both rows)
  const ids = [...new Set(rows.map((r) => r.accountId!))];
  const score = await runScoring({ pack, write: false });
  const byId = new Map((score.all ?? []).map((x) => [x.account.id, x]));
  const leads: RankInput<ScoredAccount>[] = ids.flatMap((id) => {
    const x = byId.get(id);
    return x && x.score.drivers.length ? [{ account: x.account, score: x.score, incomplete: false, recentlyDelivered: false, newSinceDelivery: false }] : [];
  });
  res.scored = leads.length;
  const contacts = await contactsFor(leads.map((l) => l.account.id), pack, { write: false, search: null });
  // analyses are a cache (same evidence + brief = same drafts): kept on a dry run too, so the real run pays nothing extra
  const an = await analyzeLeads(leads, contacts, pack, { write: true, dailyCapUsd: opts.capUsd });
  res.analyst = { fresh: an.fresh, cached: an.cached, failed: an.failed, spentUsd: an.spentUsd, skipped: an.skipped };

  const email = new Map<string, string>(), opener = new Map<string, string>(), linkedin = new Map<string, string>();
  const leadOf = new Map(leads.map((l) => [l.account.id, l]));
  for (const r of rows) {
    const l = leadOf.get(r.accountId!), n = an.analyses.get(r.accountId!);
    if (!l || !n) continue;
    const c = contacts.get(r.accountId!);
    const e = emailDraft(c, n, pack.delivery.email.signature, pack.copy.greeting);
    const li = linkedinDraft(c, n, pack.copy.linkedin.greeting);
    const op = leadOpener(c, l.account.name ?? l.account.domain, l.score.drivers[0], n) ?? "";
    if (e) { email.set(r.id, e); res.drafts.email++; }
    if (li) { linkedin.set(r.id, li); res.drafts.linkedin++; }
    if (op) opener.set(r.id, op);
    if (res.samples.length < 5 && (e || li)) res.samples.push({ company: l.account.name ?? l.account.domain, email: e, linkedin: li });
    if (opts.dryRun) continue;
    const stored = [...((r.row as string[]) ?? [])];
    const put = (col: (typeof LEAD_COLUMNS)[number], v: string | undefined) => { if (!v) return; const i = storedIndex(col); while (stored.length < i) stored.push(""); stored[i] = v; };
    put("Email draft", e); put("LinkedIn message", li); put("Opener", op);
    await db.update(deliveries).set({ sheetRow: stored }).where(eq(deliveries.id, r.id));
  }

  const sheetId = pack.delivery.sheet.spreadsheet_id;
  if (sheetId && !opts.dryRun) {
    await ensureLeadHeaders(sheetId); // adds "LinkedIn message" to a Sheet made before it existed
    res.sheet = {
      email: await fillColumnById(sheetId, "Email draft", email, true),
      opener: await fillColumnById(sheetId, "Opener", opener, true),
      linkedin: await fillColumnById(sheetId, "LinkedIn message", linkedin, true),
    };
  }
  return res;
}
