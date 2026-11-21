import { describe, it, expect } from "vitest";
import type { ExpiringAward, AndaApproval, NewsItem, Shortage, CompletedTrial } from "@tell/watchers";
import { anyWholeWord, sameCompany, splitKeywords, stateCodes, endingRows, approvalRows, shortageRows, trialRows, newsRows, newsQuery, liveFresh } from "./market-lookups.js";

const lead = { name: "Northwind Foods Inc", region: "United States of America" };
const ending = (o: Partial<ExpiringAward>): ExpiringAward => ({ awardId: "A1", recipient: "CONTOSO PROVISIONS LLC", amount: 2_400_000, endDate: new Date(Date.UTC(2027, 2, 1)), agency: "Department of Agriculture", description: "FROZEN CHICKEN STRIPS FOR DONATION PROGRAMS", naics: "3116", state: "AR", url: "https://www.usaspending.gov/award/A1", ...o });

describe("live market lookups", () => {
  it("record names match the lead's own name (the lead is never its own example)", () => {
    expect(sameCompany("NORTHWIND FOODS INC", "Northwind Foods")).toBe(true);
    expect(sameCompany("Northwind Foods Group", "Northwind Foods")).toBe(true);
    expect(sameCompany("Contoso Provisions", "Northwind Foods")).toBe(false);
  });
  it("keywords split into an industry code and product words; places into state codes", () => {
    expect(splitKeywords({ keywords: ["frozen chicken", "3116", "poultry"] })).toEqual({ naics: "3116", words: ["frozen chicken", "poultry"] });
    expect(stateCodes(["Arkansas", "AR", "Little Rock"])).toEqual(["AR"]);
  });
  it("contracts ending: other companies only, in their states when they have any", () => {
    const rows = endingRows([ending({}), ending({ awardId: "A2", recipient: "NORTHWIND FOODS INC" }), ending({ awardId: "A3", recipient: "FABRIKAM FOODS LLC", state: "CA" })], lead, ["AR"]);
    expect(rows.map((r) => r.quote)).toEqual(["Contoso Provisions LLC's $2.4M contract with the Department of Agriculture for frozen chicken strips for donation programs ends March 2027."]);
    expect(endingRows([ending({ state: "CA" })], lead, []).length).toBe(1);
  });
  it("FDA approvals and shortages match the molecule words", () => {
    const ap: AndaApproval = { appNo: "219000", sponsor: "FABRIKAM PHARMA INC", labelers: [], ingredient: "CEFOTAXIME SODIUM", form: "INJECTABLE", approvedAt: new Date(Date.UTC(2026, 10, 2)), url: "https://example.invalid/a" };
    expect(approvalRows([ap], ["cefotaxime"], lead)[0]!.quote).toBe("Fabrikam Pharma INC received FDA approval for cefotaxime sodium (injectable) on 2026-11-02 (ANDA 219000).");
    expect(approvalRows([ap], ["riluzole"], lead)).toEqual([]);
    const sh: Shortage = { substance: "CEFOTAXIME SODIUM", name: "Cefotaxime Sodium", forms: ["injectable"], availability: "Unavailable", allSame: true, reason: null, updatedAt: null } as Shortage;
    expect(shortageRows([sh], ["cefotaxime"])[0]!.quote).toBe("Cefotaxime Sodium is on the FDA drug shortage list (unavailable).");
  });
  it("trials and news name the company; a headline with no company is no example", () => {
    const t: CompletedTrial = { nctId: "NCT1", title: "A study of CP-1 patches", sponsor: "Contoso Devices", completedAt: new Date(Date.UTC(2026, 9, 1)), interventions: [{ type: "DEVICE", name: "CP-1" }], countries: ["India"], phase: "NA", url: "https://clinicaltrials.gov/study/NCT1" };
    expect(trialRows([t], lead)[0]).toMatchObject({ company: "Contoso Devices", region: "India" });
    const items: NewsItem[] = [{ title: "Contoso Foods opens new snack plant in Nashik", url: "https://news.example/1", postedAt: new Date(), outlet: "Example Times" }, { title: "Why plants matter now", url: "https://news.example/2", postedAt: null, outlet: "Example Times" }];
    expect(newsRows(items, lead, "India").map((r) => r.company)).toEqual(["Contoso Foods"]);
  });
  it("news queries fill the lead's words, place and customers; missing parts = no search", () => {
    expect(newsQuery("{keywords} new plant OR capacity expansion {place}", { keywords: ["packaging film", "bopp", "3116"], places: ["Gujarat", "GJ"] })).toBe('("packaging film" OR "bopp") new plant OR capacity expansion Gujarat');
    expect(newsQuery("{who} new plant {place}", { keywords: [], places: [], who: "food makers" })).toBe("food makers new plant");
    expect(newsQuery("{keywords} opens", { keywords: [], places: [] })).toBeNull();
  });
  it("cached live rows are reused for a week", () => {
    const now = new Date(Date.UTC(2026, 10, 21));
    expect(liveFresh("2026-11-18T00:00:00Z", now)).toBe(true);
    expect(liveFresh("2026-11-10T00:00:00Z", now)).toBe(false);
    expect(liveFresh(undefined, now)).toBe(false);
  });
  it("a contract example must name their topic in what it is for", () => {
    expect(anyWholeWord("weather radar network sustainment", ["weather"])).toBe(true);
    expect(anyWholeWord("centralized integrated real-time IT services", ["weather"])).toBe(false);
  });
});
