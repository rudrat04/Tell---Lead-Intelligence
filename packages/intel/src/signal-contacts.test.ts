import { describe, it, expect } from "vitest";
import { toRegex } from "@tell/config";
import { worksAt, pickSignalPeople, signalContactQuery } from "./signal-contacts.js";

const rx = ["(?i)procure", "(?i)purchas", "(?i)\\bprojects?\\b", "(?i)tender"].map(toRegex);
const hit = (name: string, title: string, company: string, current = true, url = `https://www.linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}`) =>
  ({ name, url, roles: [{ title, company, current }] });

describe("who to reach at the signal's company", () => {
  it("the same company: legal words dropped, a longer form of the name, or its acronym; never a different company", () => {
    expect(worksAt("Contoso Power Ltd.", "Contoso Power Limited")).toBe(true);
    expect(worksAt("Contoso Power Transmission", "Contoso Power")).toBe(true);
    expect(worksAt("CVVN", "Contoso Vidyut Vyapar Nigam")).toBe(true);
    expect(worksAt("Contoso Vidyut Vyapar Nigam Ltd", "CVVN")).toBe(true);
    expect(worksAt("Contoso Steel", "Contoso Power")).toBe(false);
    expect(worksAt("Fabrikam Solar", "Contoso Power")).toBe(false);
    // one shared word is not enough
    expect(worksAt("Contoso", "Contoso Power")).toBe(false);
  });
  it("keeps people whose CURRENT role there handles buying, at most two", () => {
    const hits = [
      hit("Asha Rao", "Head of Procurement", "Contoso Power Ltd"),
      hit("Ben Ode", "Head of Procurement", "Fabrikam Solar"), // another company
      hit("Cy Lin", "Sales Manager", "Contoso Power"), // sells, doesn't buy
      hit("Dee Mar", "Purchase Head", "Contoso Power", false), // left
      hit("Eli Sen", "GM Projects", "Contoso Power"),
      hit("Fay Kim", "Tender Manager", "Contoso Power"),
    ];
    expect(pickSignalPeople(hits, "Contoso Power", rx)).toEqual([
      { name: "Asha Rao", role: "Head of Procurement", linkedin: "https://www.linkedin.com/in/asha-rao" },
      { name: "Eli Sen", role: "GM Projects", linkedin: "https://www.linkedin.com/in/eli-sen" },
    ]);
    // a profile that isn't a LinkedIn person page is no link
    expect(pickSignalPeople([hit("Gus Ali", "Procurement Lead", "Contoso Power", true, "https://example.test/gus")], "Contoso Power", rx)[0]!.linkedin).toBeNull();
  });
  it("the search names the company and the need's topic", () => {
    expect(signalContactQuery("Contoso Power", ["head of procurement", "projects head"], "solar modules, inverters and mounting")).toBe("head of procurement or projects head for solar modules at Contoso Power");
    expect(signalContactQuery("Contoso Power", ["head of procurement"], null)).toBe("head of procurement at Contoso Power");
  });
});

import { fullEntityName, topicWords } from "./signal-contacts.js";
describe("signal company names and departments", () => {
  it("a headline acronym is spelled out from the article's own words", () => {
    expect(fullEntityName("CVVN", ["CVVN invites bids", "Contoso Vidyut Vyapar Nigam (CVVN), a wholly owned subsidiary, has invited bids"])).toBe("Contoso Vidyut Vyapar Nigam");
    expect(fullEntityName("CVVN", ["The Contoso Vidyut Vyapar Nigam (CVVN) has invited bids"])).toBe("Contoso Vidyut Vyapar Nigam");
    expect(fullEntityName("CVVN", ["Northwind Power (CVVN) said"])).toBe("CVVN"); // initials don't spell it
    expect(fullEntityName("Contoso Power", ["Contoso Power Limited (CPL)"])).toBe("Contoso Power");
  });
  it("a senior title naming what the company does is the department that owns the signal", () => {
    const words = topicWords("PV modules and inverters", "power trading and procurement of renewable energy projects");
    expect(words).toContain("renewable");
    const hits = [hit("Ira Das", "Deputy General Manager - Renewable Energy", "CONTOSO VIDYUT VYAPAR NIGAM LIMITED"), hit("Jai Rao", "Renewable Energy Analyst", "Contoso Vidyut Vyapar Nigam"),
      hit("Kai Om", "Head of Procurement", "Contoso Limited")]; // the parent company is not the signal's company
    expect(pickSignalPeople(hits, ["CVVN", "Contoso Vidyut Vyapar Nigam"], rx, 2, words).map((p) => p.name)).toEqual(["Ira Das"]);
  });
});
