import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { pickContact, type Person } from "./contacts.js";

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
