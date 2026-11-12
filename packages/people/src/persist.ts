import type { Pack } from "@tell/config";
import type { RawItem } from "@tell/watchers";
import type { PostExtraction } from "@tell/extract";
import { getDb, accounts, signals, authorMappings, personLeads, and, eq, sql } from "@tell/db";
import { signalTypeFor, type Resolution } from "./resolve.js";

export type SignalSpec = Pack["signals"]["signals"][string];

/** Writes for confirmed signals. Every write is idempotent (unique keys from migration 0002). */
export interface LeadStore {
  upsertAccount(domain: string, name: string | null): Promise<string>;
  /** returns the signal id, existing or new */
  insertSignal(s: { accountId: string | null; class: string; type: string; strength: number; evidenceQuote: string; evidenceUrl: string; observedAt: Date; halfLifeDays: number }): Promise<string>;
  addAuthorMapping(m: { platform: string; handle: string; accountId: string; confidence: string; evidenceUrl: string }): Promise<void>;
  addPersonLead(p: { platform: string; handle: string; signalId: string; score: number }): Promise<void>;
}

export type RecordOutcome = "account" | "person" | "unresolved";

/** Turn a confirmed, resolved item into an account signal or a person lead (plan 8a). */
export async function recordConfirmed(item: RawItem, x: PostExtraction, res: Resolution, specs: Record<string, SignalSpec>, store: LeadStore): Promise<RecordOutcome> {
  const type = signalTypeFor(x);
  const spec = specs[type];
  if (!spec) throw new Error(`signal type ${type} missing from the pack (signals.yaml)`);

  const accountId = res.kind === "account" ? await store.upsertAccount(res.domain, x.company_name) : null;
  const signalId = await store.insertSignal({
    accountId,
    class: spec.class,
    type,
    strength: x.strength,
    evidenceQuote: x.evidence_quote,
    evidenceUrl: item.url,
    observedAt: item.postedAt ?? new Date(),
    halfLifeDays: spec.half_life_days,
  });

  if (res.kind === "account") {
    if (item.author && res.method !== "source") {
      const platform = item.sourceId.startsWith("hn") ? "hn" : item.sourceId.includes("reddit") || item.sourceId === "forhire-subs" ? "reddit" : item.sourceId;
      await store.addAuthorMapping({ platform, handle: item.author, accountId: accountId!, confidence: res.confidence, evidenceUrl: res.evidenceUrl });
    }
    return "account";
  }
  if (res.kind === "person") {
    if (res.hint) {
      // stored for later corroboration; the signal stays unattached so a hint never feeds account scores
      const hintId = await store.upsertAccount(res.hint.domain, null);
      await store.addAuthorMapping({ platform: res.platform, handle: res.handle, accountId: hintId, confidence: "hint", evidenceUrl: res.hint.evidenceUrl });
    }
    await store.addPersonLead({ platform: res.platform, handle: res.handle, signalId, score: x.strength });
    return "person";
  }
  return "unresolved";
}

export function neonLeadStore(url = process.env.DATABASE_URL): LeadStore {
  const db = getDb(url);
  return {
    async upsertAccount(domain, name) {
      const r = await db.insert(accounts).values({ domain, name })
        .onConflictDoUpdate({ target: accounts.domain, set: { name: sql`coalesce(${accounts.name}, excluded.name)` } })
        .returning({ id: accounts.id });
      return r[0]!.id;
    },
    async insertSignal(s) {
      const r = await db.insert(signals).values(s).onConflictDoNothing({ target: [signals.evidenceUrl, signals.type] }).returning({ id: signals.id });
      if (r[0]) return r[0].id;
      const existing = await db.select({ id: signals.id }).from(signals)
        .where(and(eq(signals.evidenceUrl, s.evidenceUrl), eq(signals.type, s.type))).limit(1);
      return existing[0]!.id;
    },
    async addAuthorMapping(m) {
      await db.insert(authorMappings).values(m).onConflictDoNothing({ target: [authorMappings.platform, authorMappings.handle, authorMappings.accountId] });
    },
    async addPersonLead(p) {
      await db.insert(personLeads).values(p).onConflictDoNothing({ target: [personLeads.platform, personLeads.signalId] });
    },
  };
}
