import { describe, it, expect } from "vitest";
import { newGtmSubdomains, lookalikeCandidates } from "./infra.js";
import { parseFormIndex, normCompany } from "./formd.js";

describe("infrastructure signals", () => {
  it("only new GTM-looking subdomains count", () => {
    expect(newGtmSubdomains(["app", "www", "api"], ["app", "www", "api", "go", "lp", "staging", "eu.demo"])).toEqual(["go", "lp", "demo"]);
    expect(newGtmSubdomains(["go"], ["go"])).toEqual([]);
  });
  it("lookalike candidates are the names teams register for cold email", () => {
    const c = lookalikeCandidates("tanmark.io");
    expect(c).toContain("trytanmark.com");
    expect(c).toContain("tanmark.com");
    expect(c).not.toContain("tanmark.io");
    expect(lookalikeCandidates("ab.io")).toEqual([]);
  });
});

describe("SEC Form D", () => {
  it("parses the daily form index, keeping original Form D only", () => {
    const idx = [
      "Form Type   Company Name                                                  CIK         Date Filed  File Name",
      "---------------------------------------------------------------------------------------------------------",
      "D           Tanmark Health, Inc.                                          1234567     20261110    edgar/data/1234567/0001234567-26-000001.txt",
      "D/A         Orrin Labs LLC                                                7654321     20261110    edgar/data/7654321/0007654321-26-000002.txt",
      "10-K        Big Co Corp                                                   1111111     20261110    edgar/data/1111111/0001111111-26-000003.txt",
    ].join("\n");
    expect(parseFormIndex(idx)).toEqual([{ company: "Tanmark Health, Inc.", cik: "1234567", filedAt: new Date("2026-11-10T00:00:00Z"), url: "https://www.sec.gov/Archives/edgar/data/1234567/0001234567-26-000001.txt" }]);
  });
  it("names match exactly after dropping legal suffixes", () => {
    expect(normCompany("Tanmark Health, Inc.")).toBe(normCompany("Tanmark Health"));
    expect(normCompany("Tanmark Health Inc")).not.toBe(normCompany("Tanmark"));
  });
});
