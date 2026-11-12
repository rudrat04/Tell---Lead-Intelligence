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

