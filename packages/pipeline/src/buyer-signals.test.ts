import { describe, it, expect } from "vitest";
import type { Research } from "@tell/extract";
import { inPlaces, aboutTheirProducts, pickExamples, changeIndustries, briefText, playEvidence, type ExampleRow, type MarketPlay } from "./buyer-signals.js";

const row = (o: Partial<ExampleRow>): ExampleRow => ({ accountId: "a1", company: "Contoso Foods", region: "India", type: "capacity_expansion", quote: "commissions a snack plant in Nashik", url: "https://news.example/1", observedAt: new Date(Date.UTC(2026, 10, 10)), strength: 4, ...o });
const research: Research = { sells: "packaging films", who: "food and pharma makers", customers: ["food", "pharma"], channel: "direct to plants", module: "manufacturing_expansion", changes: ["buyers_expanding", "rivals_adding_capacity"], why: { buyers_expanding: "new food plants need film suppliers before they start" }, places: [], keywords: ["film", "packaging"] };

describe("market play", () => {
  it("one example per company, a company used once across changes, same region first", () => {
    const rows = [row({}), row({ accountId: "a2", company: "Fabrikam Pharma", region: "United States of America", strength: 5 }), row({ accountId: "a3", company: "Tailspin Dairy", strength: 3 })];
    expect(pickExamples(rows, "India", 2).map((r) => r.company)).toEqual(["Contoso Foods", "Tailspin Dairy"]);
    expect(pickExamples(rows, "India", 2, new Set(["a1"])).map((r) => r.company)).toEqual(["Tailspin Dairy", "Fabrikam Pharma"]);
  });
  it("where to look: their customers, never their own kind unless they sell to it; competitors = their own industry", () => {
    expect(changeIndustries({ whose: "customers", industries: [] }, research, "manufacturing")).toEqual(["food", "pharma"]);
    expect(changeIndustries({ whose: "customers", industries: ["food", "logistics"] }, research, "manufacturing")).toEqual(["food"]);
    expect(changeIndustries({ whose: "competitors", industries: [] }, research, "manufacturing")).toEqual(["manufacturing"]);
    expect(changeIndustries({ whose: "market", industries: ["govcon"] }, research, "manufacturing")).toEqual(["govcon"]);
  });
  const play: MarketPlay = { module: "manufacturing_expansion", moduleTitle: "Manufacturing market watch", offer: "a weekly watch on new plants in your market", research,
    changes: [
      { id: "buyers_expanding", title: "Your buyers are building new capacity", whose: "customers", why: "new food plants need film suppliers before they start", action: "reach the plant head while vendors are chosen", examples: [row({})] },
      { id: "rivals_adding_capacity", title: "Competitors are adding capacity near you", whose: "competitors", why: "they will chase your customers", action: "lock in key accounts", examples: [row({ accountId: "a9", company: "Northwind Polyfilms", quote: "to set up a film line in Vapi" })] },
    ] };
  it("the brief is written from the facts only: trigger, their business, each change with its companies and links", () => {
    const b = briefText(play, { company: "Woodgrove Packaging", trigger: { quote: "Woodgrove Packaging files DRHP for SME IPO", url: "https://news.example/0" } }, "2026-11-21");
    expect(b).toContain("Intelligence brief for Woodgrove Packaging · 2026-11-21");
    expect(b).toContain("What happened: Woodgrove Packaging files DRHP for SME IPO (https://news.example/0)");
    expect(b).toContain("Your business: packaging films, for food and pharma makers, direct to plants.");
    expect(b).toContain("1. Your buyers are building new capacity\nWhy it matters: new food plants need film suppliers before they start\n- Contoso Foods: commissions a snack plant in Nashik (https://news.example/1)");
    expect(b).toContain("How this keeps working: a weekly watch on new plants in your market");
  });
  it("draft evidence labels each example with its change", () => {
    expect(playEvidence(play).map((e) => e.quote)).toEqual(["Your buyers are building new capacity. Contoso Foods: commissions a snack plant in Nashik", "Competitors are adding capacity near you. Northwind Polyfilms: to set up a film line in Vapi"]);
  });
  it("examples for a local business come from its own places; state codes must be capitals", () => {
    expect(inPlaces("General contractor on a permit in Phoenix, AZ", ["Arizona", "AZ"])).toBe(true);
    expect(inPlaces("General contractor on a Chicago permit at 111 W Jackson Blvd", ["Arizona", "AZ"])).toBe(false);
    expect(inPlaces("a plant in Indore", ["IN"])).toBe(false);
    expect(inPlaces("Columbus, IN 47201", ["IN"])).toBe(true);
    expect(inPlaces("anywhere at all", [])).toBe(true);
  });
  it("market and competitor examples must be about what they sell", () => {
    expect(aboutTheirProducts("contract for frozen chicken strips (NAICS 3116)", ["chicken", "3116"])).toBe(true);
    expect(aboutTheirProducts("veteran suicide prevention support (NAICS 541611)", ["chicken", "3116"])).toBe(false);
    expect(aboutTheirProducts("anything", [])).toBe(false);
  });
});
