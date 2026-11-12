/** Job-ad signals from code rules on title + employment type (plan 4 / 8c). No LLM: job titles are exact records. */

export type JobFamily = "ops" | "gtm";
export interface JobClass { family: JobFamily; contract: boolean; founding: boolean }

const OPS = /\b(rev ?ops|revenue operations|sales op(eration)?s|marketing op(eration)?s|gtm (engineer|operations|ops)|go[- ]to[- ]market (engineer|operations)|growth op(eration)?s|business systems|marketing automation|crm (admin|administrator|manager|specialist|engineer|lead)|hubspot|salesforce (admin|administrator|developer|engineer)|sales systems|deal desk)\b/i;
const GTM = /\b(account executive|\bae\b|sdr|bdr|sales development|business development (rep|representative)|head of (sales|growth|marketing|revenue|gtm)|vp,? (of )?(sales|marketing|growth|revenue)|director of (sales|marketing|growth)|sales (lead|manager|director)|founding (sales|seller|marketer|marketing|growth|gtm|account executive|ae)|growth market(er|ing)|demand gen(eration)?|performance market(er|ing)|marketing (manager|lead|generalist)|product market(er|ing)|lifecycle market(er|ing)|partnerships (manager|lead))\b/i;
const NOT_GTM = /\b(sales engineer|solutions engineer|engineering manager|software engineer|data engineer)\b/i;
const CONTRACT = /\b(contract(or)?|freelance|part[- ]time|temporary|temp|fractional|consultant)\b/i;
const FOUNDING = /\b(founding|first)\b/i;

const INTERN = /\b(intern|internship|working student|apprentice)\b/i;

export function classifyJob(title: string, employmentType?: string): JobClass | null {
  // an internship isn't a funded GTM/ops need
  if (INTERN.test(title) || /intern/i.test(employmentType ?? "")) return null;
  const ops = OPS.test(title);
  const gtm = !ops && GTM.test(title) && !NOT_GTM.test(title);
  if (!ops && !gtm) return null;
  return {
    family: ops ? "ops" : "gtm",
    contract: CONTRACT.test(title) || CONTRACT.test(employmentType ?? ""),
    founding: FOUNDING.test(title),
  };
}

export interface OpenJobRow {
  id: string;
  externalId: string;
  title: string;
  url: string;
  family: JobFamily;
  postedAt: Date | null;
  firstSeenAt: Date;
}

export interface FetchedJob {
  externalId: string;
  title: string;
  url: string;
  employmentType?: string;
  postedAt?: Date;
  cls: JobClass;
}

export interface JobSignalDraft {
  type: "contract_gtm_role" | "first_gtm_role" | "ops_role_open" | "gtm_role_open" | "ops_role_open_45d" | "ops_role_filled";
  quote: string;
  url: string;
  observedAt: Date;
}

export interface BoardDiff {
  insert: FetchedJob[];
  touch: string[]; // ids still open
  close: string[]; // ids no longer listed
  signals: JobSignalDraft[];
  /** board returned nothing while several roles were open: likely a broken page, so nothing was closed */
  suspect: boolean;
}

const DAY = 86_400_000;

/**
 * Daily diff of one board's GTM/ops roles.
 * - First check (baseline): record roles, emit no "new role" signals (they aren't new to the world).
 * - New role later: contract > founding > ops > gtm (one signal per role).
 * - Ops role open 45+ days (by the board's own date when known): "struggling to hire" (signal unique per URL).
 * - Ops role gone within 30 days of being posted: likely filled -> negative signal.
 */
export function diffBoard(open: OpenJobRow[], fetched: FetchedJob[], now: Date, baselineDone: boolean): BoardDiff {
  const fetchedIds = new Set(fetched.map((f) => f.externalId));
  const openByExt = new Map(open.map((o) => [o.externalId, o]));
  const suspect = fetched.length === 0 && open.length >= 3;

  const insert = fetched.filter((f) => !openByExt.has(f.externalId));
  const touch = open.filter((o) => fetchedIds.has(o.externalId)).map((o) => o.id);
  const closing = suspect ? [] : open.filter((o) => !fetchedIds.has(o.externalId));
  const signals: JobSignalDraft[] = [];

  if (baselineDone) {
    for (const f of insert) {
      const type = f.cls.contract ? "contract_gtm_role" : f.cls.founding ? "first_gtm_role" : f.cls.family === "ops" ? "ops_role_open" : "gtm_role_open";
      signals.push({ type, quote: f.title, url: f.url, observedAt: f.postedAt && f.postedAt < now ? f.postedAt : now });
    }
  }

  // 45+ days open: from the board's posted date, or (only after baseline) from when we first saw it
  const opsOpen: { title: string; url: string; since: Date | null }[] = [
    ...open.filter((o) => fetchedIds.has(o.externalId) && o.family === "ops").map((o) => ({ title: o.title, url: o.url, since: o.postedAt ?? (baselineDone ? o.firstSeenAt : null) })),
    ...insert.filter((f) => f.cls.family === "ops").map((f) => ({ title: f.title, url: f.url, since: f.postedAt ?? null })),
  ];
  for (const j of opsOpen) {
    if (j.since && now.getTime() - j.since.getTime() >= 45 * DAY) {
      signals.push({ type: "ops_role_open_45d", quote: j.title, url: j.url, observedAt: new Date(j.since.getTime() + 45 * DAY) });
    }
  }

  for (const o of closing) {
    if (o.family !== "ops" || !o.postedAt) continue; // without a real posted date we can't say it was filled fast
    if (now.getTime() - o.postedAt.getTime() <= 30 * DAY) signals.push({ type: "ops_role_filled", quote: o.title, url: o.url, observedAt: now });
  }

  return { insert, touch, close: closing.map((o) => o.id), signals, suspect };
}
