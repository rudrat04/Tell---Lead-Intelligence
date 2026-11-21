import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { NewAward, CompletedTrial } from "@tell/watchers";
import { interleaveBySegment, keywordAwardRecords, trialRecords } from "./niche.js";

const now = new Date(Date.UTC(2026, 10, 21));
const award = (o: Partial<NewAward>): NewAward => ({ awardId: "A1", recipient: "NORTHWIND ROBOTICS LLC", amount: 1_200_000, startDate: new Date(Date.UTC(2026, 9, 1)), endDate: null, agency: "Department of Defense", description: "SBIR PHASE II - AUTONOMOUS INSPECTION DRONE", naics: "", url: "https://www.usaspending.gov/award/A1", ...o });

describe("every industry gets its turn", () => {
  it("records take turns by industry, so one industry never uses the whole lookup cap", () => {
    const xs = [..."aaaaa"].map((_, i) => ({ segment: "construction", i })).concat([{ segment: "food", i: 9 }, { segment: "trade", i: 10 }]);
    expect(interleaveBySegment(xs).slice(0, 3).map((x) => x.segment)).toEqual(["construction", "food", "trade"]);
    expect(interleaveBySegment(xs)).toHaveLength(xs.length);
  });
});

describe("keyword awards (SBIR Phase II, CRM builds)", async () => {
  const pack = await loadFixturePack();
  void pack;
  const sbir = { id: "sbir", enabled: true, keywords: ["SBIR Phase II"], must: "phase\\s*ii", signal_type: "sbir_phase2", segment: "deeptech", region: "United States of America", max_age_days: 45, min_amount: 250_000, max_pages: 1 };
  const crm = { ...sbir, id: "crm", keywords: ["Salesforce"], must: "implement|moderni", exclude: "licen[cs]e", signal_type: "crm_contract_won", segment: "govcon" };
  it("one record per recipient, largest award, phase checked in the description", () => {
    const r = keywordAwardRecords([award({}), award({ awardId: "A2", amount: 400_000 }), award({ awardId: "A3", recipient: "CONTOSO LABS INC", description: "SBIR PHASE I - SENSOR" })], sbir, now);
    expect(r).toHaveLength(1);
    expect(r[0]!.signal.type).toBe("sbir_phase2");
    expect(r[0]!.signal.quote).toContain("$1.2M federal contract from the Department of Defense");
    expect(r[0]!.segment).toBe("deeptech");
  });
  it("a license resale is not build work", () => {
    const r = keywordAwardRecords([award({ recipient: "FABRIKAM IT LLC", description: "SALESFORCE ENTERPRISE LICENSES" }), award({ recipient: "TAILSPIN DIGITAL LLC", description: "SALESFORCE IMPLEMENTATION SERVICES" })], crm, now);
    expect(r.map((x) => x.name)).toEqual(["Tailspin Digital LLC"]);
  });
});

describe("completed trials", () => {
  const cfg = { enabled: true, max_age_days: 45, regions: ["India", "United States of America"], segments: { DRUG: "pharma", DEVICE: "medtech" }, max_trials: 300 };
  const t = (o: Partial<CompletedTrial>): CompletedTrial => ({ nctId: "NCT01", title: "A study of NW-101 in adults", sponsor: "Northwind Therapeutics", completedAt: new Date(Date.UTC(2026, 10, 1)), interventions: [{ type: "DRUG", name: "NW-101" }, { type: "DRUG", name: "Placebo" }], countries: ["United States"], phase: "PHASE2", url: "https://clinicaltrials.gov/study/NCT01", ...o });
  it("segment from the intervention, placebo left out, one record per sponsor", () => {
    const r = trialRecords([t({}), t({ nctId: "NCT02", completedAt: new Date(Date.UTC(2026, 9, 1)) }), t({ sponsor: "Contoso Devices", interventions: [{ type: "DEVICE", name: "CardioPatch" }] }), t({ sponsor: "Fabrikam Behavioral", interventions: [{ type: "BEHAVIORAL", name: "coaching" }] })], cfg);
    expect(r.map((x) => [x.name, x.segment])).toEqual([["Northwind Therapeutics", "pharma"], ["Contoso Devices", "medtech"]]);
    expect(r[0]!.signal.quote).toContain("of NW-101 on 2026-11-01");
    expect(r[0]!.signal.quote).not.toContain("Placebo");
  });
});
