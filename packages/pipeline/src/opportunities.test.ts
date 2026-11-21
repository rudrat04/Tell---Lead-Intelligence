import { describe, it, expect } from "vitest";
import { loadFixturePack, OpportunitySchema } from "@tell/config";
import { domainLists } from "@tell/people";
import { newsEvents, searchMembers, isLive, eventsOpp, rosterRecords, storedGeneral } from "./opportunities.js";

const NOW = new Date("2026-11-21T00:00:00Z");
const newsOpp = OpportunitySchema.parse({
  kind: "news", label: "Pharma plant", roster: "r", queries: ["pharma plant India"], verbs: "to set up|acquires", must: "(?i)plant|acre", exclude: "(?i)opinion", max_age_days: 30,
});

describe("news events", () => {
  it("keeps matching headlines, names the company before the verb, drops old, excluded and repeated stories", () => {
    const evs = newsEvents([
      { title: "Contoso Pharma to set up plant on 40 acres in Gujarat", url: "https://n.example/1", postedAt: new Date("2026-11-19T00:00:00Z"), outlet: "Daily" },
      { title: "Contoso Pharma to set up plant on 40 acres in Gujarat", url: "https://n.example/1", postedAt: NOW },
      { title: "Opinion: why every plant needs acres", url: "https://n.example/2", postedAt: NOW },
      { title: "Fabrikam acquires land for plant", url: "https://n.example/3", postedAt: new Date("2026-09-01T00:00:00Z") },
      { title: "Markets rally on Friday", url: "https://n.example/4", postedAt: NOW },
    ], newsOpp as never, NOW);
    expect(evs.map((e) => e.entityName)).toEqual(["Contoso Pharma"]);
    expect(evs[0]!.quote).toBe("Contoso Pharma to set up plant on 40 acres in Gujarat (Daily)");
  });
  it("is live while younger than max_age_days; federal contracts while seen lately and not ended", () => {
    expect(isLive(newsOpp as never, { lastSeenAt: NOW, eventDate: new Date("2026-11-01T00:00:00Z") }, 60, NOW)).toBe(true);
    expect(isLive(newsOpp as never, { lastSeenAt: NOW, eventDate: new Date("2026-10-01T00:00:00Z") }, 60, NOW)).toBe(false);
    const fed = { kind: "usaspending_expiring", refresh_days: 7 } as never;
    expect(isLive(fed, { lastSeenAt: NOW, eventDate: new Date("2027-06-01T00:00:00Z") }, 60, NOW)).toBe(true);
    expect(isLive(fed, { lastSeenAt: new Date("2026-10-01T00:00:00Z"), eventDate: new Date("2027-06-01T00:00:00Z") }, 60, NOW)).toBe(false);
  });
  it("events_from reads another opportunity's events; a stored row reads back with its entity account", () => {
    expect(eventsOpp("b", { ...newsOpp, events_from: "a" } as never)).toBe("a");
    expect(eventsOpp("a", newsOpp as never)).toBe("a");
    const e = storedGeneral({ key: "s1", entityName: "Contoso", entityKey: "contoso", eventDate: NOW, quote: "q", url: "u", facts: { region: "India", strength: 4, accountId: "acc1", domain: "contoso.example" } })!;
    expect(e).toMatchObject({ region: "India", strength: 4, entityAccountId: "acc1", entityDomain: "contoso.example" });
  });
});

describe("company search rosters", () => {
  it("keeps companies in the roster's regions whose description says what they sell; drops directories and duplicates", async () => {
    const pack = await loadFixturePack();
    const r = { kind: "company_search", label: "x", segment: "b2b", regions: ["India"], queries: ["q"], must: "(?i)tablet|granulat", results_per_query: 10, refresh_days: 90, per_run: 30 } as const;
    const ms = searchMembers([
      { name: "Fabrikam Machines", url: "https://www.fabrikam-machines.example/about", employees: 80, description: "Maker of tablet presses and granulators.", country: "India" },
      { name: "Fabrikam Machines", url: "https://fabrikam-machines.example", employees: 80, description: "Tablet presses.", country: "IN" },
      { name: "Tailspin Toys", url: "https://tailspin.example", employees: 20, description: "Toys.", country: "India" },
      { name: "Northwind Tablets", url: "https://northwind.example", employees: 20, description: "Tablet presses.", country: "United States" },
      { name: "Machines Directory", url: "https://www.indiamart.com/x", employees: null, description: "tablet press suppliers", country: "India" },
    ], r as never, "q", domainLists(pack.domains));
    expect(ms.map((m) => m.name)).toEqual(["Fabrikam Machines"]);
    expect(ms[0]!.facts).toMatchObject({ region: "India", website: "https://fabrikam-machines.example", found: "q" });
  });
  it("roster records carry the company's own website and region for the resolvers", () => {
    const [rec] = rosterRecords("r", { kind: "company_search", segment: "b2b", regions: ["India"] } as never, [{ name: "Fabrikam Machines", facts: { region: "India", website: "https://fabrikam.example", evidence: [] } as never }], NOW);
    expect(rec).toMatchObject({ website: "https://fabrikam.example", knownRegion: "India", regions: ["India"], query: "Fabrikam Machines" });
  });
});

import { roundRobin } from "./opportunities.js";
describe("slots across opportunities", () => {
  it("takes turns so a low-scale vertical still gets in, at most `per` each", () => {
    const l = (opp: string, score: number) => ({ opportunity: { id: opp }, score: { score } });
    const got = roundRobin([l("fed", 90), l("fed", 89), l("fed", 88), l("news", 60), l("news", 55), l("sig", 40)], 5, 2);
    expect(got.map((x) => `${x.opportunity.id}${x.score.score}`)).toEqual(["fed90", "news60", "sig40", "fed89", "news55"]);
  });
});

import { foreignDomain } from "./opportunities.js";
describe("foreign domains", () => {
  it("a country-code domain from another country is not an India / US company", () => {
    expect(foreignDomain("woodgrove.se", "India")).toBe(true);
    expect(foreignDomain("acme.co.in", "India")).toBe(false);
    expect(foreignDomain("acme.com", "India")).toBe(false);
    expect(foreignDomain("acme.io", "United States of America")).toBe(false);
    expect(foreignDomain("acme.de", "United States of America")).toBe(true);
  });
});
