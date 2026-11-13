/**
 * SEC Form D filings (US private fundraising), from EDGAR's daily form index. SEC's fair-access policy requires a
 * User-Agent naming the requester with a contact email: set SEC_USER_AGENT (e.g. "Your Name you@example.com").
 * Without it nothing is fetched. robots.txt allows /Archives; at most a handful of index files per run.
 * A filing is matched to an account only by an exact, unique company-name match (never a guess).
 */

export interface FormDFiling { company: string; cik: string; filedAt: Date; url: string }

const pad = (n: number) => String(n).padStart(2, "0");

/** Parse a fixed-width EDGAR form.idx file, keeping only original Form D filings (not amendments). Exported for tests. */
export function parseFormIndex(txt: string): FormDFiling[] {
  const out: FormDFiling[] = [];
  for (const line of txt.split("\n")) {
    const m = line.match(/^(\S+(?: \S+)*?)\s{2,}(.+?)\s{2,}(\d{3,10})\s+(\d{4}-?\d{2}-?\d{2})\s+(edgar\/\S+)\s*$/);
    if (!m || m[1] !== "D") continue;
    const d = m[4]!.replace(/-/g, "");
    out.push({ company: m[2]!.trim(), cik: m[3]!, filedAt: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`), url: `https://www.sec.gov/Archives/${m[5]}` });
  }
  return out;
}

/** Form D filings from the last `days` days (weekends have no index). Empty when SEC_USER_AGENT isn't set. */
export async function fetchFormDFilings(days = 7, now = new Date(), ua = process.env.SEC_USER_AGENT): Promise<FormDFiling[]> {
  if (!ua || !/@/.test(ua)) return [];
  const out: FormDFiling[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getTime() - i * 86_400_000);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3) + 1;
    const url = `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${y}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}.idx`;
    try {
      const res = await fetch(url, { headers: { "user-agent": ua, "accept-encoding": "gzip, deflate" }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) out.push(...parseFormIndex(await res.text()));
    } catch { /* a missing day (holiday) or an outage: skip it */ }
    await new Promise((r) => setTimeout(r, 300)); // well under SEC's 10 requests/second
  }
  return out;
}

/** Company name normalised for exact matching ("Tanmark, Inc." = "Tanmark"). Exported for tests. */
export const normCompany = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ")
  .replace(/\b(inc|incorporated|llc|l l c|ltd|limited|corp|corporation|co|company|plc|lp|holdings?|technologies|technology|labs?|hq)\b/g, " ").replace(/\s+/g, " ").trim();
