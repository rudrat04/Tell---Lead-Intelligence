import { describe, it, expect } from "vitest";
import { loadFixturePack, regionGroupFor } from "@tell/config";
import { passesHardFilters, regionInScope, icpRecheck, rankByRegionGroups } from "@tell/intel";
import { matchCompany, shortageRecords, awardRecords, providerRecords, parseCsv, importRecords, regionName, distinctive } from "./niche.js";

const lists = { neverCompany: new Set(["crunchbase.com"]), freeMail: new Set(["gmail.com"]), shorteners: new Set<string>() };
const hit = (name: string, url: string, description = "", country = "India") => ({ name, url, employees: 300, description, country });

describe("niche: never guess a company", () => {
  it("needs the name, a domain carrying its distinctive word, and the industry in the description", () => {
    const pharma = /pharm|drug/i;
    expect(matchCompany("Acmegen Pharma Limited", [hit("Acmegen Pharma", "https://acmegenpharma.com", "makes generic injectables and drugs")], lists, pharma)?.domain).toBe("acmegenpharma.com");
    // same name, no industry mention: a different Acmegen
    expect(matchCompany("Acmegen Pharma Limited", [hit("Acmegen", "https://acmegen.com", "a logistics company")], lists, pharma)).toBeNull();
    // domain doesn't carry the distinctive word
    expect(matchCompany("Acmegen Pharma Limited", [hit("Acmegen Pharma", "https://pharmaco.in", "drugs")], lists, pharma)).toBeNull();
    // two domains for one name: ambiguous
    expect(matchCompany("Acmegen Pharma", [hit("Acmegen Pharma", "https://acmegen.in", "drugs"), hit("Acmegen Pharma", "https://acmegenpharma.com", "drugs")], lists, pharma)).toBeNull();
  });
  it("generic names never match (every word generic)", () => {
    expect(distinctive("Home Health Care Services LLC")).toBeNull();
    expect(matchCompany("Home Health Care Services LLC", [hit("Home Health Care Services", "https://homehealthcareservices.com", "home health")], lists)).toBeNull();
  });
  it("maps Exa countries to scoring's region names", () => {
    expect(regionName("US")).toBe("United States of America");
    expect(regionName("IN")).toBe("India");
  });
});

describe("niche records: numbers come from the records", () => {
  it("FDA shortage quote states the shortage, the ANDA and the counted holders", async () => {
    const pack = await loadFixturePack();
    const s = { substance: "ZENTROFIL SODIUM", name: "Zentrofil Sodium", forms: ["injectable"], availability: "Unavailable", allSame: true, reason: "Manufacturing Delay", updatedAt: null };
    const holders = [
      { appNo: "200001", sponsor: "ACMEGEN", labelers: ["Acmegen Pharma Limited"], marketed: false, url: "https://example.org/a" },
      { appNo: "200002", sponsor: "NORTHWIND", labelers: ["Northwind Generics LLC"], marketed: true, url: "https://example.org/b" },
    ];
    const r = shortageRecords(s, holders, pack.sources.niche.fda_shortage, new Date("2026-11-20T00:00:00Z"));
    expect(r[0]!.name).toBe("Acmegen Pharma Limited"); // likely-Indian names are looked up first
    expect(r[0]!.signal.type).toBe("shortage_anda_dormant");
    expect(r[0]!.signal.quote).toBe("Zentrofil Sodium (injectable) is on the FDA drug shortage list (unavailable; reason: manufacturing delay). Acmegen Pharma Limited holds ANDA 200001 for it but does not market it now (approved, discontinued). 2 companies hold ANDAs for it; 1 market it.");
    expect(r[1]!.signal.type).toBe("shortage_anda_marketed");
  });
  it("one contract_expiring record per incumbent, with the window's counts", async () => {
    const pack = await loadFixturePack();
    const a = (recipient: string, amount: number) => ({ awardId: "W1", recipient, amount, endDate: new Date("2027-06-14T00:00:00Z"), agency: "Department of Examples", description: "IT SUPPORT", naics: "541512", state: "VA", url: `https://www.usaspending.gov/award/${recipient}${amount}` });
    const r = awardRecords([a("NORTHWIND FEDERAL LLC", 2e6), a("NORTHWIND FEDERAL LLC", 5e6), a("SAMPLE SYSTEMS INC", 1e6)], pack.sources.niche.usaspending);
    expect(r).toHaveLength(2);
    expect(r[0]!.signal.quote).toBe("Northwind Federal LLC's $5.0M contract with the Department of Examples (it support) ends June 2027 (2027-06-14; award W1, NAICS 541512). At least 2 other contracts over $500K in NAICS 541512, worth $3.0M, end in the same window.");
  });
  it("new provider quote is dated by the certification", async () => {
    const pack = await loadFixturePack();
    const r = providerRecords([{ kind: "hospice", ccn: "999001", name: "Sampleville Hospice", city: "Austin", state: "TX", certifiedAt: new Date("2026-08-14T00:00:00Z"), url: "https://example.org/h" }], pack.sources.niche.cms_new_providers);
    expect(r[0]!.signal).toMatchObject({ type: "new_medicare_certification", observedAt: new Date("2026-08-14T00:00:00Z") });
    expect(r[0]!.signal.quote).toContain("certified by Medicare as a hospice on August 2026");
  });
});

describe("niche import (operator exports)", () => {
  it("parses quoted CSV and skips rows without a known signal type or URL", async () => {
    const pack = await loadFixturePack();
    const csv = 'company,signal_type,quote,url,date\n"Acme Castings, Pvt Ltd",funding_raise,"Acme ""raised"" seed",https://example.org/x,2026-11-01\nBad Co,unknown_type,q,https://example.org/y,\nNo Url,funding_raise,q,,';
    const rows = parseCsv(csv);
    expect(rows[0]!.company).toBe("Acme Castings, Pvt Ltd");
    const { records, skipped } = importRecords(rows, pack, { region: "India", segment: "b2b" });
    expect(records).toHaveLength(1);
    expect(records[0]!.signal.quote).toBe('Acme "raised" seed');
    expect(skipped).toBe(2);
  });
});

describe("segment overrides and segment lists", () => {
  it("a niche segment gets its own size cap and regions; others keep the defaults", async () => {
    const base = await loadFixturePack();
    const icp = { ...base.icp, hard_filters: { ...base.icp.hard_filters, team_size: { min: 5, max: 200 }, regions_any: ["India"], unknown_facts: "pass" as const,
      segment_overrides: { pharma: { team_size: { min: 20, max: 2000 } }, govcon: { team_size: { min: 5, max: 500 }, regions_any: ["United States of America"] } } } };
    const c = { domain: "acme.example", teamSize: 900, industries: [], status: null };
    expect(passesHardFilters(c, icp).pass).toBe(false);
    expect(passesHardFilters(c, icp, "pharma").pass).toBe(true);
    expect(regionInScope("United States of America", icp)).toBe(false);
    expect(regionInScope("United States of America", icp, "govcon")).toBe(true);
    const pack = { ...base, icp: { ...icp, size_bands: [{ band: "11-50", max: 50 }, { band: "51-200", max: 200 }, { band: "201-2000", max: 2000 }], segment_map: { B2B: "b2b", Pharma: "pharma" }, hard_filters: { ...icp.hard_filters, industries_any: ["B2B", "Pharma"] } } };
    expect(icpRecheck({ domain: "a.example", sizeBand: "201-2000", segment: "pharma", ycFitFailed: null }, pack)).toBeNull();
    expect(icpRecheck({ domain: "a.example", sizeBand: "201-2000", segment: "b2b", ycFitFailed: null }, pack)).toMatch(/outside the ICP/);
  });
  it("accounts in a group's segments go to that list, whatever their region", async () => {
    const base = await loadFixturePack();
    const groups = [{ name: "Niche", regions: [], segments: ["pharma"], max_leads: 5 }, { name: "India", regions: ["India"], max_leads: 5 }];
    const pack = { ...base, delivery: { ...base.delivery, digest: { ...base.delivery.digest, region_groups: groups } } };
    expect(regionGroupFor(pack, "India", "pharma")?.name).toBe("Niche");
    expect(regionGroupFor(pack, "India", "b2b")?.name).toBe("India");
    const row = (id: string, segment: string) => ({ account: { id, region: "India", segment }, score: { priority: 0.5, eligible: true, evidence: [], fastLane: false } as never, incomplete: false, recentlyDelivered: false, newSinceDelivery: false });
    const r = rankByRegionGroups([row("a", "pharma"), row("b", "b2b")], groups, (a) => a.region, 1, 5, { segmentOf: (a) => a.segment });
    expect(r.leads.map((l) => [l.account.id, (l as { group?: string }).group])).toEqual([["a", "Niche"], ["b", "India"]]);
  });
});

import { clearanceRecords, approvalRecords, newAwardRecords, formDRecords, formDRegion, socrataRecord } from "./niche.js";
import { fillTemplate, parseFormDXml, formDDocUrl, parseAndaApprovals, parseClearances } from "@tell/watchers";

describe("more public records (fictional companies)", () => {
  it("510(k) and ANDA approvals: records quote the clearance / approval and its date", async () => {
    const pack = await loadFixturePack();
    const cs = parseClearances([{ applicant: "ACMEMED DEVICES PVT LTD", k_number: "K261234", decision_date: "20261015", decision_description: "Substantially Equivalent", device_name: "Infusion Set", advisory_committee_description: "General Hospital", country_code: "IN", city: "PUNE" },
      { applicant: "X", k_number: "K2", decision_date: "20261015", decision_description: "Not Substantially Equivalent", country_code: "IN" }], ["IN"]);
    expect(cs).toHaveLength(1);
    const r = clearanceRecords(cs, { enabled: true, countries: ["IN"], regions: ["India"], max_age_days: 60, segment: "medtech" });
    expect(r[0]!.signal.quote).toBe("Acmemed Devices Pvt Ltd received FDA 510(k) clearance K261234 for infusion set (general hospital) on October 2026 (2026-10-15).");
    const as = parseAndaApprovals([{ application_number: "ANDA300001", sponsor_name: "ACMEGEN", submissions: [{ submission_type: "ORIG", submission_status: "AP", submission_status_date: "20261020" }], products: [{ active_ingredients: [{ name: "ZENTROFIL" }], dosage_form: "TABLET" }] }],
      new Date("2026-10-01T00:00:00Z"), new Date("2026-11-20T00:00:00Z"));
    expect(approvalRecords(as, { enabled: true, regions: ["India"], max_age_days: 60, segment: "pharma" })[0]!.signal.quote).toBe("Acmegen received FDA approval for ANDA 300001 (Zentrofil, tablet) on October 2026 (2026-10-20).");
    void pack;
  });
  it("new awards: one record per winner, biggest first", () => {
    const a = (r: string, amount: number) => ({ awardId: "A1", recipient: r, amount, startDate: new Date("2026-11-01T00:00:00Z"), endDate: new Date("2028-01-31T00:00:00Z"), agency: "Department of Examples", description: "ROOF REPAIR", naics: "238160", url: `https://example.org/${r}${amount}` });
    const r = newAwardRecords([a("SMALL ROOFING LLC", 3e5), a("NORTHWIND BUILDERS INC", 2e6), a("NORTHWIND BUILDERS INC", 1e6)], "construction", "United States of America", new Date("2026-11-20T00:00:00Z"));
    expect(r.map((x) => x.name)).toEqual(["Northwind Builders Inc", "Small Roofing LLC"]);
    expect(r[0]!.signal.quote).toBe("Northwind Builders Inc won a $2.0M contract from the Department of Examples (roof repair), starting November 2026 and running to January 2028 (award A1, NAICS 238160).");
  });
  it("Form D: industry -> segment, US / India only, no funds or property SPVs", () => {
    const xml = (name: string, ind: string, state = "TX") => `<edgarSubmission><primaryIssuer><entityName>${name}</entityName><issuerAddress><city>AUSTIN</city><stateOrCountry>${state}</stateOrCountry></issuerAddress></primaryIssuer><offeringData><industryGroup><industryGroupType>${ind}</industryGroupType></industryGroup><offeringSalesAmounts><totalOfferingAmount>5000000</totalOfferingAmount><totalAmountSold>2000000</totalAmountSold></offeringSalesAmounts></offeringData></edgarSubmission>`;
    const at = new Date("2026-11-18T00:00:00Z");
    const ds = [xml("Acme Precast Inc", "Construction"), xml("Elm Street Investors LLC", "Residential"), xml("Some Fund LP", "Pooled Investment Fund"), xml("Overseas Co", "Construction", "X0")].map((x) => parseFormDXml(x, at, "https://example.org/d")!);
    const r = formDRecords(ds, { enabled: true, days: 3, max_filings: 10, industries: { Construction: "construction", Residential: "real_estate" }, min_sold: 0 });
    expect(r).toHaveLength(1);
    expect(r[0]!.signal).toMatchObject({ type: "form_d_raise", quote: "Acme Precast Inc (Austin, TX) filed a Form D with the SEC on 2026-11-18: $2.0M sold of a $5.0M offering (industry: construction)." });
    expect(formDRegion("K7")).toBe("India");
    expect(formDDocUrl("https://www.sec.gov/Archives/edgar/data/123/0001234567-26-000001.txt")).toBe("https://www.sec.gov/Archives/edgar/data/123/000123456726000001/primary_doc.xml");
  });
  it("Socrata rows: templates, contact pairs, people skipped", () => {
    expect(fillTemplate("{a|title} ({b|money}, {c|date}){missing}", { a: "NORTHWIND BUILDERS LLC", b: "2500000", c: "20261101" })).toBe("Northwind Builders LLC ($2.5M, 2026-11-01)");
    const cfg = { id: "chi", enabled: true, domain: "data.example.gov", dataset: "abcd-1234", where: "", limit: 10, max_age_days: 21,
      company_pairs: { name: "contact_{i}_name", type: "contact_{i}_type", match: "GENERAL CONTRACTOR", max: 5 }, skip_company: "^(owner|self)$", key_field: "id", date_field: "issue_date",
      quote: "{company} is the GC at {addr} ({cost|money})", query: "{company} construction", signal_type: "building_permit", segment: "construction", region: "United States of America", maps_first: false };
    const now = new Date("2026-11-20T00:00:00Z");
    const r = socrataRecord({ id: "7", issue_date: "2026-11-19T00:00:00.000", addr: "1 Main St", cost: "4000000", contact_1_type: "ARCHITECT", contact_1_name: "SAMPLE, RIYA", contact_2_type: "CONTRACTOR-GENERAL CONTRACTOR", contact_2_name: "NORTHWIND BUILDERS , INC." }, cfg, now);
    expect(r?.name).toBe("Northwind Builders, Inc.");
    expect(r?.signal).toMatchObject({ quote: "Northwind Builders, Inc. is the GC at 1 Main St ($4.0M)", url: "https://data.example.gov/resource/abcd-1234.json?id=7" });
    expect(socrataRecord({ id: "8", contact_1_type: "CONTRACTOR-GENERAL CONTRACTOR", contact_1_name: "SAMPLE, RIYA" }, cfg, now)).toBeNull(); // a person
  });
});

import { nppesRecords, samRecords, recallRecords, recallSubstance, newsRecords, dmfRecords, queuePriority } from "./niche.js";
import { parseNppes, parseSamEntities, csvLine, readZipEntry } from "@tell/watchers";
import { deflateRawSync } from "node:zlib";

describe("NPPES, SAM, recalls, news, DMF (fictional)", () => {
  it("NPPES: new organisation NPIs in the listed taxonomies, with the authorized official", () => {
    const head = ['"NPI"', '"Entity Type Code"', '"Provider Organization Name (Legal Business Name)"', '"Provider Other Organization Name"', '"Provider Business Practice Location Address City Name"', '"Provider Business Practice Location Address State Name"',
      '"Provider Enumeration Date"', '"Healthcare Provider Taxonomy Code_1"', '"Authorized Official Last Name"', '"Authorized Official First Name"', '"Authorized Official Title or Position"'].join(",");
    const row = (npi: string, type: string, name: string, date: string, tax: string) => [npi, type, name, "", "AUSTIN", "TX", date, tax, "SAMPLE", "RIYA", "ADMINISTRATOR"].map((x) => `"${x}"`).join(",");
    const csv = [head, row("1999999991", "2", "SAMPLEVILLE HOME HEALTH LLC", "11/12/2026", "251E00000X"), row("1999999992", "1", "PERSON", "11/12/2026", "251E00000X"), row("1999999993", "2", "OLD CO", "01/01/2020", "251E00000X")].join("\n");
    const ns = parseNppes(csv, new Set(["251E00000X"]), new Date("2026-11-01T00:00:00Z"));
    expect(ns).toHaveLength(1);
    const r = nppesRecords(ns, { enabled: true, max_age_days: 14, taxonomies: { "251E00000X": { segment: "home_health", label: "Home health agency" } } });
    expect(r[0]!.contacts).toEqual([{ name: "Riya Sample", role: "Administrator" }]);
    expect(r[0]!.signal.quote).toBe("Sampleville Home Health LLC (Austin, TX) registered a new NPI as a home health agency on November 2026 (2026-11-12; NPI 1999999991).");
    expect(csvLine('"a","b ""c""",d')).toEqual(["a", 'b "c"', "d"]);
  });
  it("SAM: registrants by NAICS prefix, US and India, own website and contact", () => {
    const e = (name: string, naics: string, country: string, url: string | null) => ({ entityRegistration: { legalBusinessName: name, ueiSAM: `U${name.length}`, registrationDate: "2026-11-15", registrationStatus: "Active" },
      coreData: { entityInformation: { entityURL: url, entityStartDate: "2019-04-01" }, physicalAddress: { city: "PUNE", stateOrProvinceCode: "", countryCode: country } },
      assertions: { goodsAndServices: { primaryNaics: naics } }, pointsOfContact: { governmentBusinessPOC: { firstName: "RIYA", lastName: "SAMPLE", title: "CEO" } } });
    const es = parseSamEntities({ entityData: [e("ACME CASTINGS PVT LTD", "331511", "IND", "acmecastings.in"), e("NOT LISTED CO", "999999", "USA", null)] });
    const r = samRecords(es, { enabled: true, days: 3, naics_prefixes: { "33": "manufacturing" }, countries: { USA: "United States of America", IND: "India" } });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ segment: "manufacturing", knownRegion: "India", website: "acmecastings.in", contacts: [{ name: "Riya Sample", role: "Ceo" }] });
    expect(r[0]!.signal.quote).toBe("Acme Castings Pvt Ltd (Pune) registered with SAM.gov to bid on US federal contracts on 2026-11-15 (primary NAICS 331511; in business since 2019).");
  });
  it("recalls: other ANDA holders of the molecule, never the recalling firm", () => {
    const rc = { kind: "drug" as const, firm: "Northwind Pharma LLC", product: "ZENTROFIL SODIUM INJECTION, 10 mg/mL", reason: "Particulate matter", classification: "Class II", reportedAt: new Date("2026-11-10T00:00:00Z"), recallNumber: "D-0001-2027", substances: [], productCodes: [], url: "https://example.org/r" };
    expect(recallSubstance(rc)).toBe("ZENTROFIL");
    const h = (sponsor: string, labelers: string[]) => ({ appNo: "200001", sponsor, labelers, marketed: true, url: `https://example.org/${sponsor}` });
    const r = recallRecords(rc, [h("NORTHWIND", ["Northwind Pharma LLC"]), h("ACMEGEN", ["Acmegen Pharma Limited"])], { enabled: true, max_age_days: 30, regions: ["India"], segment: "pharma" });
    expect(r.map((x) => x.name)).toEqual(["Acmegen Pharma Limited"]);
    expect(r[0]!.signal.quote).toContain("Northwind Pharma LLC recalled zentrofil sodium injection");
  });
  it("news events: the company before the verb, headline as the quote", () => {
    const cfg = { id: "orders", queries: ["x"], verbs: "bags|wins", must: "order", signal_type: "order_won", segment: "manufacturing", region: "India", country: "in" };
    const r = newsRecords([{ title: "Acme Castings bags Rs 120 crore order from railways", url: "https://example.org/n1", postedAt: new Date("2026-11-18T00:00:00Z"), outlet: "Example Times" },
      { title: "Markets rally as Sensex gains", url: "https://example.org/n2", postedAt: null }], cfg, new Date("2026-11-20T00:00:00Z"));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "Acme Castings", signal: { type: "order_won", quote: "Acme Castings bags Rs 120 crore order from railways (Example Times)" } });
  });
  it("DMF: active Type II holders for a shortage molecule; salts need both words", () => {
    const sh = [{ substance: "ZENTROFIL HYDROCHLORIDE", name: "Zentrofil Hydrochloride", forms: ["injectable"], availability: "Unavailable", allSame: true, reason: null, updatedAt: null },
      { substance: "SODIUM BICARBONATE", name: "Sodium Bicarbonate", forms: ["injectable"], availability: "Unavailable", allSame: true, reason: null, updatedAt: null }];
    const rows = [{ "DMF#": "40001", STATUS: "A", TYPE: "II", "SUBMIT DATE": "2019-01-01", HOLDER: "ACMEGEN LIFESCIENCES LTD", SUBJECT: "ZENTROFIL HYDROCHLORIDE USP" },
      { "DMF#": "40002", STATUS: "I", TYPE: "II", HOLDER: "X", SUBJECT: "ZENTROFIL" }, { "DMF#": "40003", STATUS: "A", TYPE: "II", HOLDER: "Y CO", SUBJECT: "SODIUM CHLORIDE" }] as Record<string, string>[];
    const r = dmfRecords(rows, sh, new Date("2026-11-20T00:00:00Z"));
    expect(r.map((x) => x.name)).toEqual(["Acmegen Lifesciences Ltd"]);
  });
  it("queue priority: strength first, then amount", async () => {
    const pack = await loadFixturePack();
    const rec = (type: string, quote: string) => ({ source: "x", name: "n", query: "q", segment: "b2b", regions: [], signal: { type, quote, url: "u", observedAt: new Date() } });
    expect(queuePriority([rec("funding_raise", "$5.0M")], pack)).toBeGreaterThan(queuePriority([rec("funding_raise", "$1.0M")], pack));
  });
  it("zip: reads a deflated entry", () => {
    const data = Buffer.from("hello,world\n"), comp = deflateRawSync(data), name = Buffer.from("npidata_pfile_x.csv");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(0, 42);
    const cdOff = 30 + name.length + comp.length;
    const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(cdOff, 16);
    const zip = Buffer.concat([local, name, comp, central, name, eocd]);
    expect(readZipEntry(zip, (n) => n.startsWith("npidata"))?.toString()).toBe("hello,world\n");
  });
});

import { verdict } from "./niche-stats.js";
describe("plays report verdicts", () => {
  it("needs enough deliveries; meetings or replies double down; silence cuts", () => {
    expect(verdict({ delivered: 5, good: 0, bad: 0, replied: 0, meetings: 0 })).toBe("too early");
    expect(verdict({ delivered: 10, good: 2, bad: 0, replied: 2, meetings: 0 })).toBe("double down");
    expect(verdict({ delivered: 16, good: 0, bad: 3, replied: 0, meetings: 0 })).toBe("cut?");
    expect(verdict({ delivered: 10, good: 1, bad: 1, replied: 1, meetings: 0 })).toBe("keep");
  });
});

import { listInputs, toCsv } from "./sample-list.js";
describe("freelist inputs come from the lead's own quotes", () => {
  it("drug, NAICS, city, state", () => {
    expect(listInputs(["Zentrofil Sodium (injectable) is on the FDA drug shortage list (unavailable). Acmegen holds ANDA 200001 for it."]).drug).toBe("Zentrofil Sodium");
    expect(listInputs(["Northwind's $3.2M contract ends June 2027 (2027-06-14; award W1, NAICS 541512)."]).naics).toBe("541512");
    expect(listInputs(["Sampleville Hospice (Austin, TX) was certified by Medicare"])).toMatchObject({ city: "Austin", state: "TX" });
    expect(listInputs(["Northwind Builders is the general contractor on a Chicago permit at 1 Main St"]).city).toBe("Chicago");
    expect(toCsv([{ a: "x, y", b: 2 }])).toBe('a,b\n"x, y",2\n');
  });
});

import { confirmByBrand } from "./niche.js";
describe("Brand API confirms a Brandfetch match whose region is unknown", () => {
  const m = { hit: { name: "Contoso Pharma", url: "https://contosopharma.com", employees: null, description: "", country: null }, domain: "contosopharma.com" };
  it("same domain + same name + a country = confirmed, with the country", () => {
    expect(confirmByBrand("Contoso Pharma Ltd", m, { domain: "contosopharma.com", name: "Contoso Pharma", country: "India" }, lists)).toEqual({ ...m, hit: { ...m.hit, country: "India" } });
  });
  it("anything less leaves it unconfirmed (dropped, as before)", () => {
    expect(confirmByBrand("Contoso Pharma Ltd", m, null, lists)).toBeNull();
    expect(confirmByBrand("Contoso Pharma Ltd", m, { domain: "contosopharma.com", name: "Contoso Pharma", country: null }, lists)).toBeNull();
    expect(confirmByBrand("Contoso Pharma Ltd", m, { domain: "contoso.com", name: "Contoso Pharma", country: "India" }, lists)).toBeNull();
    expect(confirmByBrand("Contoso Pharma Ltd", m, { domain: "contosopharma.com", name: "Fabrikam Health", country: "India" }, lists)).toBeNull();
  });
});
