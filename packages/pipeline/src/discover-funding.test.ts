import { describe, it, expect } from "vitest";
import { companyForName } from "./discover-funding.js";

const lists = { neverCompany: new Set(["crunchbase.com", "wellfound.com"]), freeMail: new Set(["gmail.com"]), shorteners: new Set<string>() };
const hit = (name: string, url: string) => ({ name, url, employees: 20, description: "", country: "India" });

describe("funding news: never guess a domain", () => {
  it("needs the company name AND a domain carrying that name", () => {
    expect(companyForName("Paylane", [hit("Paylane", "https://paylane.in")], lists)?.domain).toBe("paylane.in");
    expect(companyForName("Paylane", [hit("Paylane", "https://getpaid.io")], lists)).toBeNull();   // name only
    expect(companyForName("Paylane", [hit("Paylane Health", "https://paylane.in")], lists)).toBeNull(); // a different name
  });
  it("skips profile and directory sites, and two different domains for one name", () => {
    expect(companyForName("Paylane", [hit("Paylane", "https://www.linkedin.com/company/paylane")], lists)).toBeNull();
    expect(companyForName("Paylane", [hit("Paylane", "https://paylane.in"), hit("Paylane", "https://paylane.com")], lists)).toBeNull();
  });
});

describe("funding news: names with suffixes", () => {
  it("'Fictiva Labs' in the headline matches the company record 'Fictiva' and 'Fictiva Labs Pvt Ltd'", () => {
    expect(companyForName("Fictiva Labs", [hit("Fictiva", "https://fictiva.in")], lists)?.domain).toBe("fictiva.in");
    expect(companyForName("Fictiva Labs", [hit("Fictiva Labs Pvt Ltd", "https://fictivalabs.com")], lists)?.domain).toBe("fictivalabs.com");
    expect(companyForName("Fictiva Labs", [hit("Fictiva Health", "https://fictiva.in")], lists)).toBeNull();
  });
});
