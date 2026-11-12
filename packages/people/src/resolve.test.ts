import { describe, it, expect } from "vitest";
import type { RawItem } from "@tell/watchers";
import type { PostExtraction } from "@tell/extract";
import { loadFixturePack } from "@tell/config";
import { domainLists, registrableDomain, rawCandidates, filterCandidates, chooseDomain, nameMatchesDomain } from "./domains.js";
import { resolveItem, type ResolverNet } from "./resolve.js";
import { recordConfirmed, type LeadStore } from "./persist.js";

const pack = await loadFixturePack();
const lists = domainLists(pack.domains);
const specs = pack.signals.signals;

const x = (o: Partial<PostExtraction> = {}): PostExtraction => ({
  author_role: "founder", ask_type: "hire", problem_category: "crm", company_identifiable: true, company_name: null,
  urgency_or_budget_hint: true, self_promotion: false, strength: 5, evidence_quote: "need help", ...o,
});
const item = (text: string, o: Partial<RawItem> = {}): RawItem => ({ sourceId: "hn", externalId: "1", url: "https://news.ycombinator.com/item?id=1", text, author: "jdoe", meta: {}, ...o });

/** Fake network: every homepage resolves to itself unless listed. */
function net(o: { homes?: Record<string, { ok: boolean; finalDomain?: string; reason?: string }>; profile?: string | null; expand?: Record<string, string> } = {}): ResolverNet & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    checkHomepage: async (d) => { calls.push(`home:${d}`); return o.homes?.[d] ?? { ok: true, finalDomain: d }; },
    expandShortUrl: async (u) => o.expand?.[u] ?? null,
    fetchProfileText: async (p, h) => { calls.push(`profile:${p}:${h}`); return o.profile ?? null; },
  };
}

describe("domains", () => {
  it("normalises to the registrable domain", () => {
    expect(registrableDomain("https://WWW.Acme.co.uk/pricing?x=1")).toBe("acme.co.uk");
    expect(registrableDomain("app.acme.io")).toBe("acme.io");
    expect(registrableDomain("http://192.168.0.1")).toBeNull();
  });
  it("keeps separate accounts for different *.github.io / *.vercel.app sites", () => {
    expect(registrableDomain("https://acme.github.io/x")).toBe("acme.github.io");
    expect(registrableDomain("https://foo.github.io")).toBe("foo.github.io");
    expect(registrableDomain("foo.vercel.app")).not.toBe(registrableDomain("bar.vercel.app"));
  });
  it("drops tool links, free mail and file-like tokens; keeps company links and work emails", () => {
    const text = "We use https://hubspot.com/docs and next.js. Mail jane@acme.com or me@gmail.com. Site: https://acme.com";
    const { company } = filterCandidates(rawCandidates(text), lists);
    expect(company.map((c) => c.domain)).toEqual(["acme.com"]);
  });
  it("never picks the first of several links; uses the company name to break ties", () => {
    const two = filterCandidates(rawCandidates("https://acme.com and https://othercorp.io"), lists).company;
    expect(chooseDomain(two, null)).toBeNull();
    expect(chooseDomain(two, "Acme Labs")?.domain).toBe("acme.com");
  });
  it("a lone link that doesn't match the named company is rejected (real case: job page on a recruiting tool)", () => {
    const one = filterCandidates(rawCandidates("Kroo | Backend Engineer | apply: https://jobs.somerecruiter.co/kroo"), lists).company;
    expect(chooseDomain(one, "Kroo")).toBeNull();
    expect(chooseDomain(one, null)?.domain).toBe("somerecruiter.co");
    expect(filterCandidates(rawCandidates("apply https://app.loxo.co/job/123"), lists).company).toEqual([]);
  });
  it("name matching", () => {
    expect(nameMatchesDomain("Acme Labs", "getacme.io")).toBe(true);
    expect(nameMatchesDomain("Ledgerly", "ledgerly.io")).toBe(true);
    expect(nameMatchesDomain("Ledgerly", "stripe.com")).toBe(false);
  });
});

describe("resolveItem", () => {
  it("HN 'Who is hiring' shape: Acme | Role | URL -> explicit account", async () => {
    const r = await resolveItem(item("Acme | Founding RevOps Engineer | Remote | https://acme.com/careers"), x({ company_name: "Acme" }), lists, net());
    expect(r).toMatchObject({ kind: "account", domain: "acme.com", confidence: "explicit" });
  });
  it("post linking only HubSpot docs is not a HubSpot account; falls to the author", async () => {
    const r = await resolveItem(item("How do I set up lead routing? https://knowledge.hubspot.com/workflows"), x({ ask_type: "how_to" }), lists, net());
    expect(r).toMatchObject({ kind: "person", platform: "hn", handle: "jdoe" });
  });
  it("name-only mention is never guessed into a domain", async () => {
    const n = net();
    const r = await resolveItem(item("We at Acme need a HubSpot freelancer"), x({ company_name: "Acme" }), lists, n);
    expect(r.kind).toBe("person");
    expect(n.calls.filter((c) => c.startsWith("home:"))).toEqual([]);
  });
  it("redirect to a different company or a parked page -> not an account", async () => {
    const r = await resolveItem(item("Hiring a CRM contractor, see https://acme.com"), x(), lists, net({ homes: { "acme.com": { ok: false, reason: "parked" } } }));
    expect(r.kind).toBe("person");
  });
  it("HN profile with one company link -> profile confidence", async () => {
    const r = await resolveItem(item("Need someone to fix our outbound"), x({ company_name: null }), lists, net({ profile: "CEO at https://ledgerly.io" }));
    expect(r).toMatchObject({ kind: "account", domain: "ledgerly.io", confidence: "profile" });
  });
  it("profile domain that contradicts the named company is only a hint", async () => {
    const r = await resolveItem(item("Ledgerly needs a CRM setup"), x({ company_name: "Ledgerly" }), lists, net({ profile: "my blog: https://janedoe.dev" }));
    expect(r).toMatchObject({ kind: "person", hint: { domain: "janedoe.dev" } });
  });
  it("Reddit authors are never followed to their profile (Responsible Builder Policy)", async () => {
    const n = net({ profile: "https://acme.com" });
    const r = await resolveItem(item("Need a HubSpot freelancer", { sourceId: "reddit" }), x(), lists, n);
    expect(r).toMatchObject({ kind: "person", platform: "reddit" });
    expect(n.calls.some((c) => c.startsWith("profile:"))).toBe(false);
  });
  it("ATS items carry their domain from the source", async () => {
    const r = await resolveItem(item("RevOps Manager", { sourceId: "ats-greenhouse", author: undefined, meta: { domain: "www.acme.com" } }), x(), lists, net());
    expect(r).toMatchObject({ kind: "account", domain: "acme.com", method: "source" });
  });
  it("expands shorteners before deciding", async () => {
    const r = await resolveItem(item("Hiring: https://bit.ly/abc"), x(), lists, net({ expand: { "https://bit.ly/abc": "https://acme.com/jobs" } }));
    expect(r).toMatchObject({ kind: "account", domain: "acme.com" });
  });
});

describe("recordConfirmed", () => {
  function memLeads() {
    const accounts = new Map<string, string>();
    const signals = new Map<string, { id: string; accountId: string | null; class: string; type: string }>();
    const mappings = new Set<string>();
    const persons = new Set<string>();
    const store: LeadStore = {
      upsertAccount: async (d) => { if (!accounts.has(d)) accounts.set(d, `acc-${accounts.size + 1}`); return accounts.get(d)!; },
      insertSignal: async (s) => { const k = `${s.evidenceUrl}|${s.type}`; if (!signals.has(k)) signals.set(k, { id: `sig-${signals.size + 1}`, accountId: s.accountId, class: s.class, type: s.type }); return signals.get(k)!.id; },
      addAuthorMapping: async (m) => { mappings.add(`${m.platform}|${m.handle}|${m.accountId}|${m.confidence}`); },
      addPersonLead: async (p) => { persons.add(`${p.platform}|${p.signalId}`); },
    };
    return { store, accounts, signals, mappings, persons };
  }

  it("account: one signal with class/half-life from signals.yaml, plus an author mapping; re-run is idempotent", async () => {
    const m = memLeads();
    const res = { kind: "account" as const, domain: "acme.com", confidence: "explicit" as const, method: "post:url", evidenceUrl: "https://news.ycombinator.com/item?id=1" };
    await recordConfirmed(item("x"), x(), res, specs, m.store);
    await recordConfirmed(item("x"), x(), res, specs, m.store);
    expect(m.signals.size).toBe(1);
    expect([...m.signals.values()][0]).toMatchObject({ type: "explicit_hire_request", class: "explicit", accountId: "acc-1" });
    expect([...m.mappings]).toEqual(["hn|jdoe|acc-1|explicit"]);
  });
  it("person: unattached signal + person lead; a hint is stored but never attached to the signal", async () => {
    const m = memLeads();
    await recordConfirmed(item("x"), x({ ask_type: "venting" }), { kind: "person", platform: "hn", handle: "jdoe", hint: { domain: "janedoe.dev", evidenceUrl: "u" }, reason: "r" }, specs, m.store);
    expect([...m.signals.values()][0]).toMatchObject({ type: "pain_post", class: "pain", accountId: null });
    expect(m.persons.size).toBe(1);
    expect([...m.mappings][0]).toContain("|hint");
  });
});
