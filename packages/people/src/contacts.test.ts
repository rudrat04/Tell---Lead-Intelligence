import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { pickContact, personaSearchLinks, type Person } from "./contacts.js";

const personas = (await loadFixturePack()).icp.personas;
const p = (name: string, role: string): Person => ({ name, role, source: "yc", linkedin: `https://linkedin.com/in/${name.split(" ")[0]}` });

describe("pickContact", () => {
  it("small company: the CEO founder over the CTO founder", () => {
    const c = pickContact([p("Farid Example", "Founder/CTO"), p("Riya Sample", "Founder/CEO")], personas, "2-10");
    expect(c).toMatchObject({ person: { name: "Riya Sample" }, persona: "Founder / CEO" });
  });
  it("larger company: the GTM/revenue leader before founders", () => {
    const c = pickContact([p("A Founder", "Co-founder & CEO"), p("B Leader", "VP of Sales")], personas, "51-150");
    expect(c).toMatchObject({ person: { name: "B Leader" }, persona: "Head of GTM / Revenue" });
  });
  it("larger company with only founders listed: falls back and says so", () => {
    const c = pickContact([p("A Founder", "Founder/CEO")], personas, "51-150");
    expect(c?.persona).toBeNull();
    expect(c?.note).toContain("best available");
  });
  it("nobody known: null", () => expect(pickContact([], personas, "2-10")).toBeNull());
});

describe("personaSearchLinks", () => {
  it("links the other personas that fit the company size, not the one already named", () => {
    const c = pickContact([p("Riya S", "Founder/CEO")], personas, "11-50");
    const links = personaSearchLinks(personas, "11-50", "Acme", c);
    expect(links.map((l) => l.persona)).toEqual(["Head of GTM / Revenue", "RevOps lead"]);
    expect(links[0]!.url).toBe("https://www.linkedin.com/search/results/people/?keywords=Head%20of%20GTM%20Acme");
  });
  it("personas limited to other company sizes are left out (founder persona is for 2-50 people)", () => {
    expect(personaSearchLinks(personas, "51-150", "Acme", null).map((l) => l.persona)).toEqual(["Head of GTM / Revenue", "RevOps lead"]);
  });
});


describe("pickContact: the play's problem owner first", () => {
  it("prefers the play's persona over the default order and ignores its size bands", async () => {
    const { pickContact } = await import("./contacts.js");
    const personas = [
      { title: "Founder / CEO", patterns: ["(?i)\\bfounder\\b"], size_bands: ["2-10", "11-50"], decision_power: 1 },
      { title: "RevOps lead", patterns: ["(?i)\\brev ?ops\\b"], size_bands: ["51-150"], decision_power: 0.6 },
    ];
    const people = [{ name: "Ravi T", role: "Founder", source: "yc" }, { name: "Mila O", role: "RevOps Manager", source: "exa" }];
    expect(pickContact(people, personas, "11-50")!.person.name).toBe("Ravi T");
    expect(pickContact(people, personas, "11-50", ["RevOps lead"])!.person.name).toBe("Mila O");
  });
});

describe("people events from dated roles", () => {
  it("a GTM leader who started recently, and an ops person who left, at this company only", async () => {
    const { peopleEvents } = await import("./contacts.js");
    const now = new Date("2026-11-14T00:00:00Z");
    const ops = [/\brev ?ops|revenue operations\b/i];
    const hit = { url: "https://linkedin.example/in/x", roles: [
      { title: "VP Sales", company: "Tanmark", current: true, from: "2026-09-01", to: null },
      { title: "RevOps Manager", company: "Tanmark", current: false, from: "2024-01-01", to: "2026-08-01" },
      { title: "Head of Sales", company: "Orrin", current: true, from: "2026-10-01", to: null },
      { title: "Account Executive", company: "Tanmark", current: false, from: "2023-01-01", to: "2026-10-01" },
    ] };
    expect(peopleEvents(hit, "Tanmark", "tanmark.test", ops, now).map((e) => [e.type, e.quote])).toEqual([
      ["new_gtm_leader", "New VP Sales since Sep 2026"],
      ["ops_person_left", "RevOps Manager left in Aug 2026"],
    ]);
  });

  it("pack leader titles replace the built-in GTM list (a new COO counts; a new VP Sales then only if listed)", async () => {
    const { peopleEvents } = await import("./contacts.js");
    const now = new Date("2026-11-14T00:00:00Z");
    const hit = { url: "https://linkedin.example/in/y", roles: [
      { title: "Chief Operating Officer", company: "Tanmark", current: true, from: "2026-10-01", to: null },
      { title: "VP Sales", company: "Tanmark", current: true, from: "2026-10-01", to: null },
    ] };
    expect(peopleEvents(hit, "Tanmark", "tanmark.test", [], now).map((e) => e.quote)).toEqual(["New VP Sales since Oct 2026"]);
    expect(peopleEvents(hit, "Tanmark", "tanmark.test", [], now, [/\b(chief operating officer|coo)\b/i]).map((e) => e.quote)).toEqual(["New Chief Operating Officer since Oct 2026"]);
  });
});

describe("buyer years of experience", async () => {
  const { pickContact, yearsOfExperience } = await import("./contacts.js");
  const now = new Date("2026-11-19T00:00:00Z");
  const person = (name: string, role: string, from?: string) => ({ name, role, source: "exa", workHistory: from ? [{ company: "Fictiva", from }] : null });
  it("years from the earliest dated role; unknown without dates", () => {
    expect(Math.round(yearsOfExperience(person("A", "Head of Sales", "2016-11-01"), now)!)).toBe(10);
    expect(yearsOfExperience(person("A", "Head of Sales"), now)).toBeNull();
  });
  it("a buyer's years range skips people outside it, never people with no history", () => {
    const buyers = [{ title: "Head of Sales", patterns: ["(?i)head of sales"], size_bands: [], years: { min: 5, max: 30 }, decision_power: 0.8 }];
    const junior = person("Nia Rao", "Head of Sales", new Date().getFullYear() - 1 + "-01-01");
    const unknown = person("Dev Shah", "Head of Sales");
    expect(pickContact([junior], buyers, null)?.persona).toBeNull();
    expect(pickContact([junior, unknown], buyers, null)?.person.name).toBe("Dev Shah");
  });
});
