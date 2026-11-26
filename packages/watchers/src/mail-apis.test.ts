import { describe, it, expect } from "vitest";
import { parseQev, parseHunter, parseProspeo } from "./mail-apis.js";
import { parseDiffbotOrgs } from "./resolvers.js";

describe("email and company APIs", () => {
  it("QuickEmailVerification: valid / invalid / catch-all", () => {
    expect(parseQev({ success: "true", result: "valid", accept_all: "false", disposable: "false" })).toEqual({ result: "valid", acceptAll: false, disposable: false });
    expect(parseQev({ success: "true", result: "valid", accept_all: "true", disposable: "false" })?.acceptAll).toBe(true);
    expect(parseQev({ success: "false", message: "blank" })).toBeNull();
  });
  it("Hunter and Prospeo finder answers", () => {
    expect(parseHunter({ data: { email: "Asha@Northwind.test", score: 91, verification: { status: "valid" } } })).toEqual({ address: "asha@northwind.test", score: 91, verified: true });
    expect(parseHunter({ data: { email: null } })).toBeNull();
    // Enrich Person: person.email, VERIFIED; a masked (unrevealed) address is no answer; the company's site comes back
    expect(parseProspeo({ error: false, person: { email: { email: "Ravi@contoso.test", status: "VERIFIED", revealed: true } }, company: { website: "https://www.contoso.test/" } }))
      .toEqual({ address: "ravi@contoso.test", score: null, verified: true, domain: "contoso.test" });
    expect(parseProspeo({ error: false, person: { email: { email: "ravi.*****@contoso.test", status: "VERIFIED", revealed: false } } })).toBeNull();
    expect(parseProspeo({ error: false, person: { email: null } })).toBeNull();
    expect(parseProspeo({ error: true })).toBeNull();
  });
  it("Diffbot organisations carry website, size and country", () => {
    expect(parseDiffbotOrgs({ data: [{ entity: { name: "Northwind Foods", homepageUri: "northwind.test", nbEmployees: 26, description: "makes egg products", location: { country: { name: "United States" } } } }, { entity: { name: "No Site Co" } }] }))
      .toEqual([{ name: "Northwind Foods", url: "https://northwind.test", employees: 26, description: "makes egg products", country: "United States" }]);
  });
});

import { addressesInHits } from "./mail-apis.js";
describe("addresses in web search results", () => {
  it("keeps addresses on the company's domain from titles and snippets, once each", () => {
    expect(addressesInHits([
      { title: "Ravi Sen - Contoso", snippet: "Contact Ravi Sen at ravi.sen@contoso.test or sales@contoso.test.", link: "https://dir.example/a" },
      { snippet: "ravi.sen@contoso.test; ravi@gmail.com; x@notcontoso.test", link: "https://dir.example/b" },
    ], "contoso.test")).toEqual([{ address: "ravi.sen@contoso.test", url: "https://dir.example/a" }, { address: "sales@contoso.test", url: "https://dir.example/a" }]);
  });
});

import { parseHunterAccount } from "./mail-apis.js";
describe("Hunter account balance", () => {
  it("reads the credit pool, else searches; nothing usable is null", () => {
    expect(parseHunterAccount({ data: { requests: { credits: { used: 23, available: 50 }, searches: { used: 9, available: 25 } } } })).toBe(27);
    expect(parseHunterAccount({ data: { requests: { searches: { used: 30, available: 25 } } } })).toBe(0);
    expect(parseHunterAccount({ errors: [{ id: "authentication_failed" }] })).toBeNull();
  });
});
