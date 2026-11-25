import { describe, it, expect } from "vitest";
import { siteOf } from "./signal-contacts.js";

describe("the signal company's own website", () => {
  const names = ["Contoso Vidyut Vyapar Nigam"];
  it("a site whose domain carries the full name compacted or its initials", () => {
    // a title that matches is not enough: the domain must carry the name
    expect(siteOf({ name: "Contoso Vidyut Vyapar Nigam Ltd", url: "https://www.contosovvn.example/" }, names)).toBeNull();
    expect(siteOf({ name: "Contoso Vidyut Vyapar Nigam", url: "https://www.zoominfo.example/c/cvvn" }, names)).toBeNull();
    expect(siteOf({ name: "Home", url: "https://cvvn.co.example/about" }, names)).toBe("cvvn.co.example");
    expect(siteOf({ name: "Home", url: "https://contosovidyutvyaparnigam.example" }, names)).toBe("contosovidyutvyaparnigam.example");
  });
  it("never a directory, social profile or another company's site", () => {
    expect(siteOf({ name: "Contoso Vidyut Vyapar Nigam", url: "https://in.linkedin.com/company/cvvn" }, names)).toBeNull();
    expect(siteOf({ name: "Contoso Vidyut Vyapar Nigam - Zauba", url: "https://www.zaubacorp.com/company/x" }, names)).toBeNull();
    expect(siteOf({ name: "Fabrikam Solar", url: "https://fabrikam.example" }, names)).toBeNull();
    // a one-word name matches only itself (signalDomain never passes a bare acronym)
    expect(siteOf({ name: "x", url: "https://cvvn.example" }, ["CVVN"])).toBe("cvvn.example");
    expect(siteOf({ name: "x", url: "https://c.example" }, ["Contoso"])).toBeNull();
  });
});

import { othersFor } from "./contacts.js";
describe("everyone else to reach at the company", () => {
  it("up to three more people whose titles match your buyers, the lead's own buyers first, one row per name", () => {
    const personas = [{ title: "Founder / CEO", patterns: ["(?i)\\b(ceo|founder)\\b"], size_bands: [] }, { title: "Head of Sales", patterns: ["(?i)\\bsales\\b"], size_bands: [] }] as never;
    const p = (name: string, role: string) => ({ name, role, source: "exa" });
    const list = [p("Asha Rao", "CEO"), p("Ben Ode", "VP Sales"), p("Cy Lin", "Co-founder"), p("Dee Mar", "Sales Head"), p("Eli Sen", "Engineer"), p("Fay Kim", "Head of Sales")];
    const contact = { person: list[0]!, persona: "Founder / CEO", note: "" };
    expect(othersFor(contact, list, personas, ["Head of Sales"]).map((o) => o.person.name)).toEqual(["Ben Ode", "Dee Mar", "Fay Kim"]);
  });
});
