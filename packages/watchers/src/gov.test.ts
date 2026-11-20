import { describe, it, expect } from "vitest";
import { parseShortages, parseAndaHolders, holderCounts, formFamily, parseAwards, parseProviders } from "./gov.js";

// synthetic records shaped like the APIs' (fictional companies)
const shortage = (o: Record<string, unknown>) => ({ status: "Current", availability: "Limited Availability", generic_name: "Zentrofil Injection", dosage_form: "Injection", update_date: "11/06/2026", openfda: { substance_name: ["ZENTROFIL SODIUM"] }, ...o });

describe("openFDA shortages", () => {
  it("groups package records by substance and skips resolved ones", () => {
    const s = parseShortages([
      shortage({}),
      shortage({ availability: "Unavailable", related_info: "Shortage per Manufacturer: Manufacturing Delay; Next Delivery: TBD" }),
      shortage({ availability: "Available", openfda: { substance_name: ["OTHERMIDE"] } }),
      shortage({ status: "Resolved", openfda: { substance_name: ["THIRDOL"] } }),
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ substance: "ZENTROFIL SODIUM", name: "Zentrofil Sodium", availability: "Unavailable", allSame: false, reason: "Manufacturing Delay", forms: ["injectable"] });
  });
  it("tells dosage form families apart", () => {
    expect(formFamily("INJECTABLE INJECTION")).toBe("injectable");
    expect(formFamily("TABLET ORAL")).toBe("oral");
    expect(formFamily("SOLUTION/DROPS OPHTHALMIC")).toBe("ophthalmic");
  });
});

describe("Drugs@FDA ANDA holders", () => {
  const app = (no: string, sponsor: string, products: { dosage_form: string; route: string; marketing_status: string }[], labelers?: string[]) =>
    ({ application_number: `ANDA${no}`, sponsor_name: sponsor, products, ...(labelers ? { openfda: { manufacturer_name: labelers } } : {}) });
  const inj = (m: string) => ({ dosage_form: "INJECTABLE", route: "INJECTION", marketing_status: m });
  it("keeps holders with a product in the shortage's form; tentative approvals and other forms don't count", () => {
    const h = parseAndaHolders([
      app("200001", "ACMEGEN", [inj("Prescription")], ["Acmegen Pharma Limited"]),
      app("200002", "BETAMED", [inj("Discontinued")]),
      app("200003", "GAMMA", [inj("None (Tentative Approval)")]),
      app("200004", "DELTA", [{ dosage_form: "TABLET", route: "ORAL", marketing_status: "Prescription" }]),
      { application_number: "NDA100000", sponsor_name: "BRAND", products: [inj("Prescription")] },
    ], ["injectable"]);
    expect(h.map((x) => [x.appNo, x.marketed])).toEqual([["200001", true], ["200002", false]]);
    expect(h[0]!.url).toContain("ApplNo=200001");
    expect(holderCounts(h)).toEqual({ holders: 2, marketed: 1 });
  });
});

describe("USASpending expiring awards", () => {
  const from = new Date("2027-01-01T00:00:00Z"), to = new Date("2027-12-31T00:00:00Z");
  const row = (end: string, amount: number, name = "Northwind Federal LLC") => ({ "Award ID": "X1", "Recipient Name": name, "Award Amount": amount, "End Date": end, "Awarding Agency": "Department of Examples", generated_internal_id: `CONT_AWD_${end}` });
  it("keeps awards ending inside the window and over the minimum amount", () => {
    const a = parseAwards([row("2027-06-14", 2e6), row("2026-12-01", 2e6), row("2027-06-14", 1e5), row("2027-03-01", 3e6, "MULTIPLE RECIPIENTS")], "541512", from, to, 5e5);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ recipient: "Northwind Federal LLC", naics: "541512", url: "https://www.usaspending.gov/award/CONT_AWD_2027-06-14" });
  });
});

describe("CMS new providers", () => {
  it("keeps providers certified since the cutoff, in the listed states", () => {
    const p = parseProviders("home_health", [
      { provider_name: "SAMPLEVILLE HOME HEALTH LLC", cms_certification_number_ccn: "999001", citytown: "AUSTIN", state: "TX", certification_date: "08/14/2026" },
      { provider_name: "OLDTOWN HOME CARE", cms_certification_number_ccn: "999002", citytown: "RENO", state: "NV", certification_date: "05/17/1990" },
      { provider_name: "ELSEWHERE HOME HEALTH", cms_certification_number_ccn: "999003", citytown: "MIAMI", state: "FL", certification_date: "09/01/2026" },
    ], new Date("2026-06-01T00:00:00Z"), ["TX"]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ name: "Sampleville Home Health LLC", city: "Austin", state: "TX", url: "https://www.medicare.gov/care-compare/details/home-health/999001" });
  });
});
