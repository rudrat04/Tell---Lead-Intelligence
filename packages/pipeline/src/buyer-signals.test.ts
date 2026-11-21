import { describe, it, expect } from "vitest";
import { pickSample, sampleEvidence, type BuyerRow } from "./buyer-signals.js";

const row = (o: Partial<BuyerRow>): BuyerRow => ({ accountId: "a1", company: "Contoso Foods", region: "India", type: "capacity_expansion", quote: "commissions a snack plant in Nashik", url: "https://news.example/1", observedAt: new Date(Date.UTC(2026, 10, 10)), strength: 4, ...o });

describe("buyer signals sample", () => {
  it("one row per company, the lead's region first, then strongest and newest", () => {
    const rows = [row({}), row({ accountId: "a1", quote: "older", observedAt: new Date(Date.UTC(2026, 9, 1)) }), row({ accountId: "a2", company: "Fabrikam Pharma", region: "United States of America", strength: 5 }), row({ accountId: "a3", company: "Tailspin Dairy", strength: 3 })];
    expect(pickSample(rows, "India").map((r) => r.company)).toEqual(["Contoso Foods", "Tailspin Dairy", "Fabrikam Pharma"]);
    expect(pickSample(rows, "India")[0]!.quote).toBe("commissions a snack plant in Nashik");
  });
  it("evidence names each company with its own fact, and the count comes from the rows", () => {
    const ev = sampleEvidence({ who: "food and pharma makers", total: 14, rows: [row({}), row({ accountId: "a3", company: "Tailspin Dairy", quote: "expands capacity in Anand" })] });
    expect(ev.map((e) => e.quote)).toEqual(["Contoso Foods: commissions a snack plant in Nashik", "Tailspin Dairy: expands capacity in Anand", "In the last 60 days, 14 food and pharma makers showed signs of new demand in public records and news."]);
  });
});
