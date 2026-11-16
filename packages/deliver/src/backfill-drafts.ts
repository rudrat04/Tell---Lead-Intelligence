import type { Pack } from "@tell/config";
import { runScoring, contactsFor, analyzeLeads, type ScoredAccount } from "@tell/pipeline";
import type { RankInput } from "@tell/intel";
import { getDb, deliveries, eq, sql } from "@tell/db";
import { emailDraft, linkedinDraft, leadOpener } from "./render.js";
import { ensureLeadHeaders, fillColumnById, storedRow } from "./sheets.js";

export interface BackfillDraftsResult {
  deliveries: number;
  scored: number;
  analyst: { fresh: number; cached: number; failed: number; spentUsd: number; skipped?: string };
  drafts: { email: number; linkedin: number; cleared: number };
  /** why drafts were dropped after every rewrite, by kind of problem (counts only) */
  failures: Record<string, number>;
  sheet: { email: number; opener: number; linkedin: number } | null;
  /** local review only (never printed in CI) */
  samples: { company: string; email: string; linkedin: string }[];
}

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
  const res: BackfillDraftsResult = { deliveries: rows.length, scored: 0, analyst: { fresh: 0, cached: 0, failed: 0, spentUsd: 0 }, drafts: { email: 0, linkedin: 0, cleared: 0 }, failures: {}, sheet: null, samples: [] };
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
  const kind = (p: string) => p.replace(/\s*\(.*$/, "").replace(/"[^"]*"/g, "…").slice(0, 50);
  for (const n of an.analyses.values()) {
    for (const p of [...(n.emailProblems ?? []), ...(n.linkedinProblems ?? [])]) res.failures[kind(p)] = (res.failures[kind(p)] ?? 0) + 1;
  }
  for (const r of rows) {
    const l = leadOf.get(r.accountId!), n = an.analyses.get(r.accountId!);
    if (!l) continue; // out of scope now (e.g. region): its old drafts stay as they were
    const c = contacts.get(r.accountId!);
    const e = n ? emailDraft(c, n, pack.delivery.email.signature, pack.copy.greeting) : "";
    const li = n ? linkedinDraft(c, n, pack.copy.linkedin.greeting) : "";
    const op = leadOpener(c, l.account.name ?? l.account.domain, l.score.drivers[0], n) ?? "";
    // a draft that doesn't pass today's checks clears the old one: an empty cell beats a draft in the old voice
    email.set(r.id, e); linkedin.set(r.id, li);
    if (e) res.drafts.email++;
    if (li) res.drafts.linkedin++;
    if (!e || !li) res.drafts.cleared++;
    if (op) opener.set(r.id, op);
    if (res.samples.length < 5 && (e || li)) res.samples.push({ company: l.account.name ?? l.account.domain, email: e, linkedin: li });
    if (opts.dryRun) continue;
    const stored = { ...storedRow(r.row), "Email draft": e, "LinkedIn message": li, ...(op ? { Opener: op } : {}) };
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
