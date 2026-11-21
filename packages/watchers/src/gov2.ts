/**
 * More public-record sources (Nov 2026):
 *   NPPES weekly incremental file (download.cms.gov, no key): organisations that got a new NPI last week (clinics,
 *     home health, hospices, labs, DME suppliers...), with the authorized official's name and title.
 *   SAM.gov entity registrations (SAM_API_KEY; personal keys get 10 requests a day): a bulk extract is requested on
 *     one run and downloaded on a later one, so a day costs two requests.
 *   openFDA recalls (drug / device enforcement, no key).
 *   Google Places Text Search (GOOGLE_MAPS_API_KEY, 1,000 free website lookups a month) or Serper places
 *     (SERPER_API_KEY): a company's website when the company index has none. Only the website is used, and only after
 *     our own homepage check; nothing else from Places is stored.
 */
import { userAgent } from "./identity.js";
import { readZipEntry } from "./zip.js";
import { anyDate } from "./gov.js";

const title = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

// ------------------------------------------------------------------------------------------------ NPPES

export interface NewNpi { npi: string; name: string; taxonomy: string; city: string; state: string; enumeratedAt: Date; official: { name: string; title: string } | null; url: string }

/** The newest weekly V2 file linked from the NPPES downloads page. */
export async function latestNppesWeeklyUrl(): Promise<string | null> {
  const res = await fetch("https://download.cms.gov/nppes/NPI_Files.html", { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return null;
  const links = [...(await res.text()).matchAll(/href='\.\/(NPPES_Data_Dissemination_(\d{6})_(\d{6})_Weekly_V2\.zip)'/g)];
  const key = (m: RegExpMatchArray) => { const d = m[3]!; return `${d.slice(4, 6)}${d.slice(0, 4)}`; };
  const newest = links.sort((a, b) => key(b).localeCompare(key(a)))[0];
  return newest ? `https://download.cms.gov/nppes/${newest[1]}` : null;
}

/** One CSV line -> cells (NPPES quotes every field; no embedded newlines). Exported for tests. */
export function csvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cell); cell = ""; }
    else cell += ch;
  }
  out.push(cell);
  return out;
}

/** New organisation NPIs with one of these primary taxonomies, enumerated on or after `since` (pure; exported for tests). */
export function parseNppes(csv: string, taxonomies: Set<string>, since: Date): NewNpi[] {
  const lines = csv.split(/\r?\n/);
  const h = csvLine(lines[0] ?? "");
  const col = (n: string) => h.indexOf(n);
  const c = {
    npi: col("NPI"), type: col("Entity Type Code"), org: col("Provider Organization Name (Legal Business Name)"), other: col("Provider Other Organization Name"),
    city: col("Provider Business Practice Location Address City Name"), state: col("Provider Business Practice Location Address State Name"),
    date: col("Provider Enumeration Date"), tax: col("Healthcare Provider Taxonomy Code_1"),
    offLast: col("Authorized Official Last Name"), offFirst: col("Authorized Official First Name"), offTitle: col("Authorized Official Title or Position"),
  };
  if (c.npi < 0 || c.org < 0 || c.tax < 0) throw new Error("unexpected NPPES columns");
  const out: NewNpi[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || !line.includes('"2"')) continue; // organisations only (cheap pre-check)
    const r = csvLine(line);
    if (r[c.type] !== "2" || !taxonomies.has(r[c.tax] ?? "")) continue;
    const m = (r[c.date] ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    const at = m ? new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`) : null;
    if (!at || at < since) continue;
    const name = (r[c.other] || r[c.org] || "").trim();
    if (!name) continue;
    const off = [r[c.offFirst], r[c.offLast]].filter(Boolean).map((x) => title(x!)).join(" ");
    out.push({ npi: r[c.npi]!, name: title(name).replace(/\b(Llc|Lp|Llp|Pllc|Pc|Pa)\b/g, (x) => x.toUpperCase()), taxonomy: r[c.tax]!, city: title(r[c.city] ?? ""), state: r[c.state] ?? "", enumeratedAt: at,
      official: off ? { name: off, title: title(r[c.offTitle] ?? "") } : null, url: `https://npiregistry.cms.hhs.gov/provider-view/${r[c.npi]}` });
  }
  return out;
}

export async function fetchNppesWeekly(taxonomies: Set<string>, since: Date): Promise<NewNpi[]> {
  const url = await latestNppesWeeklyUrl();
  if (!url) throw new Error("no NPPES weekly file found");
  const res = await fetch(url, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`NPPES ${res.status}`);
  const csv = readZipEntry(Buffer.from(await res.arrayBuffer()), (n) => /^npidata_pfile_.*\.csv$/.test(n) && !/fileheader/.test(n));
  if (!csv) throw new Error("NPPES file has no npidata csv");
  return parseNppes(csv.toString("utf8"), taxonomies, since);
}

// ------------------------------------------------------------------------------------------------ SAM.gov entities

export interface SamEntity { uei: string; name: string; website: string | null; city: string; state: string; country: string; registeredAt: Date; startedAt: Date | null; naics: string; contact: { name: string; title: string } | null }

/** Entities from a SAM entity extract or API page (pure; exported for tests). */
export function parseSamEntities(j: unknown): SamEntity[] {
  const list = ((j as { entityData?: unknown[] } | null)?.entityData ?? []) as Record<string, any>[];
  return list.flatMap((e) => {
    const r = e.entityRegistration ?? {}, core = e.coreData ?? {}, poc = e.pointsOfContact ?? {};
    const at = anyDate(r.registrationDate);
    if (!r.legalBusinessName || !r.ueiSAM || !at || r.registrationStatus !== "Active") return [];
    const p = poc.governmentBusinessPOC ?? poc.electronicBusinessPOC ?? null;
    const pn = p ? [p.firstName, p.lastName].filter(Boolean).map((x: string) => title(x)).join(" ") : "";
    const addr = core.physicalAddress ?? {};
    return [{ uei: r.ueiSAM, name: title(r.dbaName || r.legalBusinessName).replace(/\b(Llc|Lp|Llp|Pllc)\b/g, (x) => x.toUpperCase()), website: core.entityInformation?.entityURL ?? null,
      city: title(addr.city ?? ""), state: addr.stateOrProvinceCode ?? "", country: addr.countryCode ?? "", registeredAt: at, startedAt: anyDate(core.entityInformation?.entityStartDate),
      naics: String(e.assertions?.goodsAndServices?.primaryNaics ?? ""), contact: pn ? { name: pn, title: title(p.title ?? "") } : null }];
  });
}

const samUrl = (path: string, key: string, q: Record<string, string>) => `https://api.sam.gov/entity-information/v3/${path}?${new URLSearchParams({ api_key: key, ...q })}`;

/** Ask SAM for a JSON extract of entities registered in [from, to]; returns the download token. One request. */
export async function requestSamExtract(key: string, from: Date, to: Date): Promise<string> {
  const d = (x: Date) => `${String(x.getUTCMonth() + 1).padStart(2, "0")}/${String(x.getUTCDate()).padStart(2, "0")}/${x.getUTCFullYear()}`;
  const res = await fetch(samUrl("entities", key, { registrationDate: `[${d(from)},${d(to)}]`, purposeOfRegistrationCode: "Z2", format: "JSON", includeSections: "entityRegistration,coreData,assertions,pointsOfContact" }),
    { signal: AbortSignal.timeout(60_000) });
  const t = await res.text();
  const token = t.match(/token=([A-Za-z0-9_-]+)/)?.[1];
  if (!res.ok || !token) throw new Error(`SAM extract request ${res.status}`);
  return token;
}

/** Download a requested extract: null while SAM is still building it (a later run tries again). One request. */
export async function downloadSamExtract(key: string, token: string): Promise<SamEntity[] | null> {
  const res = await fetch(samUrl("download-entities", key, { token }), { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (res.status === 429) throw new Error("SAM daily quota reached");
  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok || buf.length < 50) return null; // not ready yet (SAM answers with a redirect or an empty body)
  const body = buf.readUInt32LE(0) === 0x04034b50 ? readZipEntry(buf, (n) => /\.json$/i.test(n)) : buf;
  if (!body) return null;
  const text = body.toString("utf8");
  if (!text.trim().startsWith("{")) return null;
  return parseSamEntities(JSON.parse(text));
}

// ------------------------------------------------------------------------------------------------ openFDA recalls

export interface Recall { kind: "drug" | "device"; firm: string; product: string; reason: string; classification: string; reportedAt: Date; recallNumber: string; substances: string[]; productCodes: string[]; url: string }

export function parseRecalls(kind: Recall["kind"], results: unknown[]): Recall[] {
  return results.flatMap((x) => {
    const r = x as Record<string, any>;
    const at = anyDate(r.report_date);
    if (!r.recalling_firm || !at || !r.recall_number) return [];
    return [{ kind, firm: String(r.recalling_firm).trim(), product: String(r.product_description ?? "").replace(/\s+/g, " ").slice(0, 160), reason: String(r.reason_for_recall ?? "").replace(/\s+/g, " ").slice(0, 160),
      classification: String(r.classification ?? ""), reportedAt: at, recallNumber: String(r.recall_number), substances: (r.openfda?.substance_name ?? []) as string[], productCodes: [...new Set<string>([...(r.product_code ? [String(r.product_code)] : []), ...((r.openfda?.product_code ?? []) as string[])])],
      url: `https://api.fda.gov/${kind}/enforcement.json?search=recall_number:%22${encodeURIComponent(String(r.recall_number))}%22` }];
  });
}

export async function fetchRecalls(kind: Recall["kind"], since: Date, now = new Date(), apiKey = process.env.OPENFDA_API_KEY): Promise<Recall[]> {
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const q = `report_date:[${ymd(since)} TO ${ymd(now)}] AND (classification:"Class I" OR classification:"Class II")`;
  const res = await fetch(`https://api.fda.gov/${kind}/enforcement.json?search=${encodeURIComponent(q)}&limit=1000${apiKey ? `&api_key=${apiKey}` : ""}`, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(45_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`openFDA recalls ${res.status}`);
  return parseRecalls(kind, ((await res.json()) as { results?: unknown[] }).results ?? []);
}

/** Other 510(k) holders for a device product code (competitors of a recalling firm). */
export async function fetchProductCodeHolders(code: string, apiKey = process.env.OPENFDA_API_KEY): Promise<{ applicant: string; kNumber: string; country: string; url: string }[]> {
  const res = await fetch(`https://api.fda.gov/device/510k.json?search=product_code:${encodeURIComponent(code)}+AND+decision_date:%5B20200101+TO+20991231%5D&limit=100${apiKey ? `&api_key=${apiKey}` : ""}`, { headers: { "user-agent": userAgent() }, signal: AbortSignal.timeout(45_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`openFDA 510k ${res.status}`);
  const rows = (((await res.json()) as { results?: Record<string, string>[] }).results ?? []);
  return rows.filter((r) => r.applicant && r.k_number).map((r) => ({ applicant: r.applicant!.trim(), kNumber: r.k_number!, country: r.country_code ?? "", url: `https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${r.k_number}` }));
}

// ------------------------------------------------------------------------------------------------ Maps (websites)

export interface PlaceHit { name: string; website: string | null; address: string }

/** Google Places Text Search (New): name, address, website. One billable request (Enterprise SKU, 1,000 free a month). */
export async function googlePlaces(apiKey: string, query: string, regionCode: string): Promise<PlaceHit[]> {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": apiKey, "x-goog-fieldmask": "places.displayName,places.formattedAddress,places.websiteUri" },
    body: JSON.stringify({ textQuery: query, pageSize: 5, regionCode, languageCode: "en" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`places ${res.status}`);
  const j = (await res.json()) as { places?: { displayName?: { text?: string }; formattedAddress?: string; websiteUri?: string }[] };
  return (j.places ?? []).map((p) => ({ name: p.displayName?.text ?? "", website: p.websiteUri ?? null, address: p.formattedAddress ?? "" }));
}

/** Serper places (Google Maps results via SERPER_API_KEY, one credit). */
export async function serperPlaces(apiKey: string, query: string, gl: string): Promise<PlaceHit[]> {
  const res = await fetch("https://google.serper.dev/places", { method: "POST", headers: { "x-api-key": apiKey, "content-type": "application/json" }, body: JSON.stringify({ q: query, gl }), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`serper places ${res.status}`);
  const j = (await res.json()) as { places?: { title?: string; website?: string; address?: string }[] };
  return (j.places ?? []).map((p) => ({ name: p.title ?? "", website: p.website ?? null, address: p.address ?? "" }));
}

// ------------------------------------------------------------------------------------------------ SAM: websites by UEI

/** SAM entity records -> UEI -> the website the company registered (pure; exported for tests). A UEI with several
 *  records keeps the first one that lists a site. */
export function parseSamWebsites(j: unknown): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const e of ((j as { entityData?: unknown[] } | null)?.entityData ?? []) as { entityRegistration?: { ueiSAM?: string }; coreData?: { entityInformation?: { entityURL?: string | null } } }[]) {
    const uei = e.entityRegistration?.ueiSAM;
    if (!uei) continue;
    const site = e.coreData?.entityInformation?.entityURL?.trim() || null;
    if (!out.get(uei)) out.set(uei, site);
  }
  return out;
}

/** UEIs per SAM request: the API returns 10 records a page and some UEIs have two, so 8 fit one page. */
export const SAM_UEIS_PER_REQUEST = 8;

/** The websites companies registered in SAM.gov, for up to SAM_UEIS_PER_REQUEST UEIs in ONE request (personal keys
 *  allow 10 requests a day). UEIs SAM doesn't return are absent from the map. */
export async function samWebsitesByUei(key: string, ueis: string[]): Promise<Map<string, string | null>> {
  const list = ueis.filter((u) => /^[A-Z0-9]{12}$/.test(u)).slice(0, SAM_UEIS_PER_REQUEST);
  if (!list.length) return new Map();
  const res = await fetch(samUrl("entities", key, { ueiSAM: `[${list.join("~")}]`, includeSections: "entityRegistration,coreData", samRegistered: "Yes" }), { signal: AbortSignal.timeout(30_000) });
  if (res.status === 429) throw new Error("SAM daily quota reached");
  if (!res.ok) throw new Error(`SAM entities ${res.status}`);
  return parseSamWebsites(await res.json());
}
