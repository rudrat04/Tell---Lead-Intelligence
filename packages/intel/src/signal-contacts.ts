/**
 * Who to reach at the company behind a signal (pure part). An opportunity lead is a business that can act on another
 * company's event (a tender, a new plant, an order); the operator also wants the people at that other company who deal
 * with what it must buy: procurement, purchase, projects, contracts and tenders. They come from a people search on the
 * company's name, so a person counts only when their CURRENT role is at that company (same name once legal words go,
 * a longer form of the same name, or its acronym: "Contoso Vidyut Vyapar Nigam" = "CVVN") and their title matches the
 * pack's patterns. Never guessed: a name, a title and a profile link, no email.
 */

export interface SignalPerson { name: string; role: string; linkedin: string | null;
  /** only a sure address, found on a click (never guessed) */
  email?: { address: string; status: "verified" | "observed"; note: string } | null;
  /** the company's own website, once known */
  domain?: string | null }
export interface SignalHit { name: string | null; url: string; roles: { title: string; company: string; current: boolean }[] }

const LEGAL = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|pvt|private|corp|corporation|co|company|lp|llp|plc|the|of|and|india|group)\b/g;
const words = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[.,()]/g, " ").replace(LEGAL, " ").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean);

/** Is `company` (from a person's work history) the company named `entity` in the signal? (pure; exported for tests) */
export function worksAt(company: string, entity: string): boolean {
  const a = words(company), b = words(entity);
  if (!a.length || !b.length) return false;
  const ja = a.join(""), jb = b.join("");
  if (ja.length >= 3 && ja === jb) return true;
  // a longer form of the same name ("Contoso Power" / "Contoso Power Transmission"): the shorter one's words, at least
  // two of them, start the longer one ("Tata Power" never matches "Tata Steel")
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (s.length >= 2 && s.every((w, i) => l[i] === w)) return true;
  // an acronym: "CVVN" = "Contoso Vidyut Vyapar Nigam" (3+ letters, every word's initial)
  const acr = (ws: string[]) => ws.map((w) => w[0]).join("");
  if (a.length === 1 && b.length >= 3 && a[0]!.length >= 3 && a[0] === acr(b)) return true;
  if (b.length === 1 && a.length >= 3 && b[0]!.length >= 3 && b[0] === acr(a)) return true;
  return false;
}

/** A headline acronym ("CVVN") spelled out from the article's own text ("Contoso Vidyut Vyapar Nigam (CVVN)"): the
 *  words just before it in brackets whose initials are the acronym. The name as given when it isn't an acronym or the
 *  text never spells it out (pure; exported for tests). People search knows companies by their full names. */
export function fullEntityName(entity: string, texts: (string | null | undefined)[]): string {
  const acr = entity.trim();
  if (!/^[A-Z][A-Z0-9&]{1,7}$/.test(acr)) return entity;
  const esc = acr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const t of texts) {
    const m = (t ?? "").match(new RegExp(`((?:[A-Z][\\w&.-]*\\s+){1,8})\\(\\s*${esc}\\s*\\)`));
    if (!m) continue;
    const ws = m[1]!.trim().split(/\s+/);
    // the longest run of words ending just before the bracket whose initials spell the acronym
    for (let i = 0; i < ws.length; i++) {
      const run = ws.slice(i);
      if (run.map((w) => w[0]!.toUpperCase()).join("") === acr.toUpperCase()) return run.join(" ");
    }
  }
  return entity;
}

/** The longer words of what the signal's company does and must buy ("renewable", "solar"): a senior title naming one
 *  ("DGM - Renewable Energy") is the department that owns the signal (pure; exported for tests). */
export const topicWords = (...texts: (string | null | undefined)[]) =>
  [...new Set(texts.join(" ").toLowerCase().match(/\b[a-z]{5,}\b/g) ?? [])].filter((w) => !TOPIC_STOP.has(w));
const TOPIC_STOP = new Set(["their", "which", "other", "about", "under", "where", "there", "these", "those", "services", "service", "company", "companies",
  "limited", "private", "india", "indian", "wholly", "owned", "subsidiary", "invites", "invited", "based", "maker", "makers", "supplier", "suppliers", "distributor",
  "contractor", "contractors", "provider", "providers", "systems", "system", "designated", "premises", "buildings", "government", "including", "subsequent", "complete", "execution"]);
const SENIOR = /\b(head|chief|director|vp|vice president|gm|dgm|agm|general manager|president|lead)\b/i;

/** The people search query for one signal's company (pure; exported for tests). */
export function signalContactQuery(entity: string, titles: string[], topic?: string | null): string {
  const t = (topic ?? "").replace(/[^\p{L}\p{N} ,/-]+/gu, " ").replace(/\s+/g, " ").trim().split(/,|\band\b|\//)[0]!.trim().split(" ").slice(0, 4).join(" ");
  return `${titles.slice(0, 3).join(" or ")}${t ? ` for ${t}` : ""} at ${entity}`;
}

/** The people worth reaching at the signal's company, best first, at most `max` (pure; exported for tests). */
export function pickSignalPeople(hits: SignalHit[], entity: string | string[], patterns: RegExp[], max = 2, topic: string[] = []): SignalPerson[] {
  const names = Array.isArray(entity) ? entity : [entity];
  const fits = (title: string) => patterns.some((rx) => rx.test(title)) || (SENIOR.test(title) && topic.some((w) => title.toLowerCase().includes(w)));
  const out: SignalPerson[] = [];
  for (const h of hits) {
    const name = (h.name ?? "").trim();
    if (!name || out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    const role = h.roles.find((r) => r.current && names.some((n) => worksAt(r.company, n)) && fits(r.title));
    if (!role) continue;
    out.push({ name, role: role.title, linkedin: /linkedin\.com\/in\//i.test(h.url) ? h.url : null });
    if (out.length >= max) break;
  }
  return out;
}

/** "Jo Doe, Head of Procurement · Ana Ray, Projects Head" (pure). */
export const signalPeopleText = (ps: SignalPerson[]) => ps.map((p) => `${p.name}, ${p.role}${p.email ? ` <${p.email.address}>` : ""}`).join(" · ");
