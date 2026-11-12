import { toRegex, type Pack } from "@tell/config";

/**
 * Job-ad signals from code rules on title + employment type (plan 4 / 8c). No LLM: job titles are exact records.
 * Role families come from the pack's roles.yaml:
 *   core     = the role you substitute for or bridge (open long = struggling to hire; removed fast = filled)
 *   adjacent = roles that show the need is forming
 */
export type JobFamily = "core" | "adjacent";
export interface JobClass { family: JobFamily; contract: boolean; founding: boolean }

export interface RoleRules { core: RegExp[]; adjacent: RegExp[]; exclude: RegExp[]; contract: RegExp[]; founding: RegExp[] }

export function compileRoles(roles: Pack["roles"]): RoleRules {
  return {
    core: roles.core.map(toRegex), adjacent: roles.adjacent.map(toRegex), exclude: roles.exclude.map(toRegex),
    contract: roles.contract.map(toRegex), founding: roles.founding.map(toRegex),
  };
}

const any = (rs: RegExp[], s: string) => rs.some((r) => r.test(s));

export function classifyJob(title: string, employmentType: string | undefined, rules: RoleRules): JobClass | null {
  // excluded titles (lookalikes, internships) and intern employment types are never a funded need
  if (any(rules.exclude, title) || /intern/i.test(employmentType ?? "")) return null;
  const core = any(rules.core, title);
  const adjacent = !core && any(rules.adjacent, title);
  if (!core && !adjacent) return null;
  return {
    family: core ? "core" : "adjacent",
    contract: any(rules.contract, title) || any(rules.contract, employmentType ?? ""),
    founding: any(rules.founding, title),
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
  type: "contract_role" | "first_role" | "core_role_open" | "adjacent_role_open" | "core_role_open_45d" | "core_role_filled";
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
 * Daily diff of one board's core/adjacent roles.
 * - First check (baseline): record roles, emit no "new role" signals (they aren't new to the world).
 * - New role later: contract > founding > core > adjacent (one signal per role).
 * - Core role open 45+ days (by the board's own date when known): "struggling to hire" (signal unique per URL).
 * - Core role gone within 30 days of being posted: likely filled -> negative signal.
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
      const type = f.cls.contract && f.cls.family === "core" ? "contract_role" : f.cls.founding ? "first_role" : f.cls.family === "core" ? "core_role_open" : "adjacent_role_open";
      signals.push({ type, quote: f.title, url: f.url, observedAt: f.postedAt && f.postedAt < now ? f.postedAt : now });
    }
  }

  // 45+ days open: from the board's posted date, or (only after baseline) from when we first saw it
  const coreOpen: { title: string; url: string; since: Date | null }[] = [
    ...open.filter((o) => fetchedIds.has(o.externalId) && o.family === "core").map((o) => ({ title: o.title, url: o.url, since: o.postedAt ?? (baselineDone ? o.firstSeenAt : null) })),
    ...insert.filter((f) => f.cls.family === "core").map((f) => ({ title: f.title, url: f.url, since: f.postedAt ?? null })),
  ];
  for (const j of coreOpen) {
    if (j.since && now.getTime() - j.since.getTime() >= 45 * DAY) {
      signals.push({ type: "core_role_open_45d", quote: j.title, url: j.url, observedAt: new Date(j.since.getTime() + 45 * DAY) });
    }
  }

  for (const o of closing) {
    if (o.family !== "core" || !o.postedAt) continue; // without a real posted date we can't say it was filled fast
    if (now.getTime() - o.postedAt.getTime() <= 30 * DAY) signals.push({ type: "core_role_filled", quote: o.title, url: o.url, observedAt: now });
  }

  return { insert, touch, close: closing.map((o) => o.id), signals, suspect };
}
