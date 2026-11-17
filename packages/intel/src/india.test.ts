import { describe, it, expect } from "vitest";
import { regionFromPostings, countryOf, looksLikeStaffing } from "./india.js";

describe("region from job locations", () => {
  it("India when at least half the located roles are in India", () => {
    expect(regionFromPostings([{ countryCodes: ["IN"] }, { location: "Dubai, UAE" }])).toBe("India");
    expect(regionFromPostings([{ location: "Gurugram, Haryana" }, { location: "" }])).toBe("India");
  });
  it("unknown (not guessed) otherwise", () => {
    expect(regionFromPostings([{ location: "Cairo, Egypt" }, { location: "Riyadh" }, { location: "Pune" }])).toBeNull();
    expect(regionFromPostings([{}, { location: " " }])).toBeNull();
  });
  it("other in-scope countries, with the names accounts already use", () => {
    expect(regionFromPostings([{ countryCodes: ["US"] }, { location: "Austin, TX" }])).toBe("United States of America");
    expect(regionFromPostings([{ location: "London, UK" }, { location: "Remote" }])).toBe("United Kingdom");
    expect(regionFromPostings([{ location: "Dubai" }, { location: "Abu Dhabi, UAE" }, { location: "Pune" }])).toBe("United Arab Emirates");
    expect(regionFromPostings([{ countryCodes: ["SG"] }])).toBe("Singapore");
    expect(regionFromPostings([{ location: "Toronto, ON" }])).toBe("Canada");
  });
  it("India wins a tie, so India detection is unchanged", () => {
    expect(regionFromPostings([{ location: "Bengaluru" }, { location: "Mumbai" }, { countryCodes: ["US"] }, { location: "New York" }])).toBe("India");
  });
  it("ambiguous words name no country", () => {
    expect(countryOf({ location: "Come join us" })).toBeNull();
    expect(countryOf({ location: "Cambridge" })).toBeNull();
    expect(countryOf({ location: "San Jose, CA" })).toBe("United States of America");
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
