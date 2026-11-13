import { describe, it, expect } from "vitest";
import { regionFromPostings, looksLikeStaffing } from "./india.js";

describe("region from job locations", () => {
  it("India when at least half the located roles are in India", () => {
    expect(regionFromPostings([{ countryCodes: ["IN"] }, { location: "Dubai, UAE" }])).toBe("India");
    expect(regionFromPostings([{ location: "Gurugram, Haryana" }, { location: "" }])).toBe("India");
  });
  it("unknown (not guessed) otherwise", () => {
    expect(regionFromPostings([{ location: "Cairo, Egypt" }, { location: "Riyadh" }, { location: "Pune" }])).toBeNull();
    expect(regionFromPostings([{}, { location: " " }])).toBeNull();
  });
});

describe("staffing agencies", () => {
  it("by name", () => {
    expect(looksLikeStaffing("Northwind Staffing Solutions", [])).toBe(true);
    expect(looksLikeStaffing("Acme Pay", [])).toBe(false);
  });
  it("by role texts that hire for clients", () => {
    expect(looksLikeStaffing("Acme", ["Acme is hiring a Senior Accountant for one of our clients in FMCG", "We are hiring for our client, a leading bank"])).toBe(true);
    expect(looksLikeStaffing("Acme", ["Own our CRM and reporting for the sales team", "Build the outbound engine for our customers"])).toBe(false);
  });
});
