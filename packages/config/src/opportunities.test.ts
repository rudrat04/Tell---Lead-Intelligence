import { describe, it, expect } from "vitest";
import { loadFixturePack } from "./fixture.js";
import { PackSchema } from "./schema.js";

const issues = (p: unknown) => { const r = PackSchema.safeParse(p); return r.success ? [] : r.error.issues.map((i) => i.message); };
const base = async () => structuredClone(await loadFixturePack()) as unknown as Record<string, any>;
const roster = { kind: "usaspending_awardees", label: "Federal IT", segment: "b2b", naics: ["541512"], set_asides: ["8a"] };
const opp = { kind: "usaspending_expiring", label: "Federal recompete", roster: "fed_it", set_asides: ["8a"], buyers: ["Founder / CEO"] };

describe("opportunities.yaml", () => {
  it("defaults off when the file is missing", async () => {
    const p = await loadFixturePack();
    expect(p.opportunities.enabled).toBe(false);
    expect(p.opportunities.opportunities).toEqual({});
  });
  it("a valid roster + opportunity passes and fills defaults", async () => {
    const p = await base();
    p.opportunities = { enabled: true, rosters: { fed_it: roster }, opportunities: { recompete: opp } };
    const r = PackSchema.safeParse(p);
    expect(r.success).toBe(true);
    const op = r.data!.opportunities.opportunities.recompete!;
    expect(op.kind === "usaspending_expiring" && op.sweet_spot_days).toEqual([180, 365]);
  });
  it("names what is wrong: unknown roster, unknown buyer, a set-aside the roster never queries, a bad NAICS", async () => {
    const p = await base();
    p.opportunities = { enabled: true, rosters: { fed_it: { ...roster, set_asides: [], naics: ["5415123"] } },
      opportunities: { a: { ...opp, roster: "nope" }, b: { ...opp, buyers: ["Chief Vibes Officer"] } } };
    const msg = issues(p).join("\n");
    expect(msg).toMatch(/NAICS must be 2, 4 or 6 digits/);
    expect(msg).toMatch(/unknown roster "nope"/);
    expect(msg).toMatch(/unknown buyer "Chief Vibes Officer"/);
    expect(msg).toMatch(/set-aside "8a" events can never match/);
  });
  it("a roster in an industry the ICP doesn't admit", async () => {
    const p = await base();
    p.opportunities = { enabled: true, rosters: { fed_it: { ...roster, segment: "govcon" } }, opportunities: {} };
    expect(issues(p).join()).toMatch(/segment "govcon" is not an industry the ICP admits/);
  });
});

describe("news / signals opportunities", () => {
  it("events_from must name an opportunity that collects its own; signal types must exist; federal rosters only for contracts", async () => {
    const p = await base();
    p.opportunities = { enabled: true,
      rosters: { fed_it: roster, search: { kind: "company_search", label: "S", segment: "b2b", regions: ["India"], queries: ["staffing company India"] } },
      opportunities: {
        news: { kind: "news", label: "N", roster: "search", queries: ["pharma plant India"] },
        copy: { kind: "news", label: "C", roster: "search", events_from: "nope" },
        sig: { kind: "signals", label: "S", roster: "search", types: ["not_a_type"] },
        wrong: { kind: "news", label: "W", roster: "fed_it", queries: ["pharma plant India"] },
        empty: { kind: "news", label: "E", roster: "search" },
      } };
    const msg = issues(p).join("\n");
    expect(msg).toMatch(/events_from must name a news \/ signals opportunity/);
    expect(msg).toMatch(/unknown signal type "not_a_type"/);
    expect(msg).toMatch(/news \/ signals events match company_search or import rosters/);
    expect(msg).toMatch(/a news opportunity needs queries/);
    expect(msg).not.toMatch(/opportunities\.news\b.*/);
  });
});
