import { describe, it, expect } from "vitest";
import type { Pack } from "@tell/config";
import type { EventCheck } from "@tell/extract";
import { normSupplier, tradeId, tradesFrom, withTrades, cleanSupplier } from "./trades.js";
import { gateEvent } from "./event-checks.js";

const US = "United States of America";
const pack = {
  meta: { regions: ["India"] },
  icp: { industries: { manufacturing: { label: "Manufacturing" }, logistics: { label: "Logistics" }, software: { label: "Software" } }, personas: [{ title: "Founder / CEO" }, { title: "Head of Sales" }] },
  opportunities: {
    min_stage: "early", exclude_entity_industries: ["software"], window_days: 60,
    trades: { enabled: true, buyers: ["Founder / CEO", "Head of Sales", "Unknown title"], results_per_query: 10, refresh_days: 30, max_age_days: 45, per_run: 10 },
    rosters: { in_automation_packaging: { kind: "company_search", label: "Automation and packaging", segment: "manufacturing", regions: ["India"], queries: ["x"] } },
    opportunities: {},
  },
} as unknown as Pack;

const check = (o: Partial<EventCheck>): EventCheck => ({ verdict: "ok", happened: "h", quote: "q", entitySells: "soft drinks", entityIndustry: "food", where: "India", stage: "committed",
  stageQuote: "s", needs: [], reason: "", source: "article", ...o });

describe("trades: any business a verified need asks for", () => {
  it("the same supplier worded differently is one trade; another place or industry is another", () => {
    expect(normSupplier("Pharmaceutical process equipment manufacturers")).toBe(normSupplier("pharma process equipment maker"));
    expect(normSupplier("cold chain transport company")).toBe(normSupplier("Cold-chain transportation companies"));
    const n = { supplier: "beverage filling line maker", industry: "manufacturing" };
    expect(tradeId(n, "India")).toBe(tradeId({ ...n, supplier: "Beverage filling line manufacturers" }, "India"));
    expect(tradeId(n, "India")).not.toBe(tradeId(n, US));
    expect(tradeId({ ...n, industry: "logistics" }, "India")).not.toBe(tradeId(n, "India"));
    expect(tradeId({ ...n, supplier: "company" }, "India")).toBeNull();
    expect(cleanSupplier("Civil and geotechnical survey contractors (India)")).toBe("Civil and geotechnical survey contractors");
    expect(cleanSupplier("none")).toBe("");
  });
  it("needs a roster already covers stay with it; IT signals, paused regions and unchecked events name no trade", () => {
    const needs = [
      { what: "bottling lines", supplier: "filling line maker", industry: "manufacturing", quote: "q", group: "in_automation_packaging" },
      { what: "chilled transport of finished drinks", supplier: "cold chain transport company", industry: "logistics", quote: "q", group: null },
    ];
    const got = tradesFrom([
      { check: check({ needs }), eventRegion: null },
      { check: check({ needs, entityIndustry: "software" }), eventRegion: null },
      { check: check({ needs, where: US }), eventRegion: null },
      { check: check({ needs, verdict: "unclear" }), eventRegion: null },
      { check: check({ needs: [needs[1]!], where: null }), eventRegion: "India" },
    ], pack);
    expect(got.map((t) => t.supplier)).toEqual(["cold chain transport company"]);
  });
  it("a trade becomes a roster and an opportunity, gated to exactly the needs that named it", () => {
    const n = { what: "chilled transport of finished drinks", supplier: "cold chain transport company", industry: "logistics", quote: "q", group: null };
    const id = tradeId(n, "India")!;
    const p = withTrades(pack, [{ id, supplier: n.supplier, industry: n.industry, region: "India", what: n.what, lastSeenAt: new Date() }]);
    const r = p.opportunities.rosters[id]!, op = p.opportunities.opportunities[id]!;
    expect(r).toMatchObject({ kind: "company_search", segment: "logistics", regions: ["India"], queries: ["cold chain transport company in India"] });
    expect(op).toMatchObject({ kind: "signals", roster: id, buyers: ["Founder / CEO", "Head of Sales"], types: [] });
    const other = { ...n, what: "warehouse racks", supplier: "storage racking maker", industry: "manufacturing" };
    const g = gateEvent(check({ needs: [other, n] }), op as Parameters<typeof gateEvent>[1], r, "India", "early", null, id);
    expect(g.ok && g.need.what).toBe("chilled transport of finished drinks");
    expect(gateEvent(check({ needs: [other] }), op as Parameters<typeof gateEvent>[1], r, "India", "early", null, id)).toEqual({ ok: false, why: "not-their-trade" });
    expect(gateEvent(check({ needs: [n], entityIndustry: "software" }), op as Parameters<typeof gateEvent>[1], r, "India", "early", null, id, ["software"])).toEqual({ ok: false, why: "excluded-industry" });
  });
});

import { jobsEvents } from "./opportunities.js";
describe("job posts for a new site", () => {
  const op = { kind: "jobs", site: "(?i)(new|upcoming|greenfield|proposed|under construction|expansion of)[^.]{0,40}(plant|factory|facility|unit|site|warehouse|hospital|campus)|green ?field|plant (start|set)[- ]?up", max_age_days: 45 } as never;
  const job = (description: string, employer = "Contoso Foods") => ({ jobId: description.slice(0, 12), title: "Plant Head", employer, website: null, applyLink: "https://jobs.example/1", publisher: null, location: "Nashik", countryCodes: ["IN"], description });
  it("a posting that says the role is for a new plant is a signal, quoted in its own words", () => {
    const ev = jobsEvents([job("We are hiring for our upcoming greenfield plant at Nashik. Lead commissioning and hiring.")], op, new Date());
    expect(ev).toHaveLength(1);
    expect(ev[0]!.quote).toContain('"We are hiring for our upcoming greenfield plant at Nashik."');
  });
  it("a requirement about the candidate, or a staffing agency's post, is not", () => {
    expect(jobsEvents([job("Exposure to greenfield projects and plant commissioning will be preferred.")], op, new Date())).toHaveLength(0);
    expect(jobsEvents([job("Our client is setting up a new plant in Pune.", "Woodgrove Staffing Solutions")], op, new Date())).toHaveLength(0);
  });
});
