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
    expect(parseProspeo({ error: false, response: { email: { email: "ravi@contoso.test", email_status: "VALID" } } })).toEqual({ address: "ravi@contoso.test", score: null, verified: true });
    expect(parseProspeo({ error: true })).toBeNull();
  });
  it("Diffbot organisations carry website, size and country", () => {
    expect(parseDiffbotOrgs({ data: [{ entity: { name: "Northwind Foods", homepageUri: "northwind.test", nbEmployees: 26, description: "makes egg products", location: { country: { name: "United States" } } } }, { entity: { name: "No Site Co" } }] }))
      .toEqual([{ name: "Northwind Foods", url: "https://northwind.test", employees: 26, description: "makes egg products", country: "United States" }]);
  });
});
