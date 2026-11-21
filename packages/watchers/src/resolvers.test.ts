import { describe, it, expect } from "vitest";
import { parseWikidata, titleName, parseTrials } from "./resolvers.js";

describe("resolvers", () => {
  it("Wikidata: official website and country; items without a website are dropped", () => {
    const j = { entities: {
      Q1: { labels: { en: { value: "Northwind Pharma" } }, descriptions: { en: { value: "Indian pharmaceutical company" } }, claims: { P856: [{ mainsnak: { datavalue: { value: "https://northwind.test" } } }], P17: [{ mainsnak: { datavalue: { value: { id: "Q668" } } } }] } },
      Q2: { labels: { en: { value: "Northwind (film)" } }, claims: {} },
    } };
    expect(parseWikidata(j)).toEqual([{ name: "Northwind Pharma", url: "https://northwind.test", employees: null, description: "Indian pharmaceutical company", country: "India" }]);
  });
  it("web result titles become company names", () => {
    expect(titleName("Northwind Pharma | Generic APIs")).toBe("Northwind Pharma");
    expect(titleName("Contoso Logistics - Home")).toBe("Contoso Logistics");
  });
  it("ClinicalTrials.gov studies parse into sponsor, date and interventions", () => {
    const j = { studies: [{ protocolSection: { identificationModule: { nctId: "NCT9", briefTitle: "A trial" }, statusModule: { completionDateStruct: { date: "2026-10" } },
      sponsorCollaboratorsModule: { leadSponsor: { name: "Contoso Bio" } }, armsInterventionsModule: { interventions: [{ type: "DEVICE", name: "Patch" }] }, contactsLocationsModule: { locations: [{ country: "India" }] } } }] };
    const [t] = parseTrials(j);
    expect(t!.sponsor).toBe("Contoso Bio");
    expect(t!.completedAt.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(t!.interventions).toEqual([{ type: "DEVICE", name: "Patch" }]);
  });
});
