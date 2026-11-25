import { describe, it, expect } from "vitest";
import { parseOwners } from "./signal-owners.js";
import { parseExplain } from "./lead-explain.js";

describe("who owns the purchase", () => {
  const i = { company: "Contoso Pharma", happened: "Contoso Pharma will set up an oral solid plant in Ahmedabad", need: "granulators" };
  it("keeps specific titles, drops sales and bare seniority words, and a place only when the text names it", () => {
    expect(parseOwners(JSON.stringify({ department: "Plant engineering", titles: ["Head of Projects", "Sales Manager", "Manager", "Plant Head", "GM Procurement"], location: "Ahmedabad" }), i))
      .toEqual({ department: "Plant engineering", titles: ["Head of Projects", "Plant Head", "GM Procurement"], location: "Ahmedabad" });
    expect(parseOwners(JSON.stringify({ department: "x", titles: ["Head of Projects"], location: "Mumbai" }), i)?.location).toBeNull();
    expect(parseOwners(JSON.stringify({ department: "x", titles: ["Sales Head"], location: "" }), i)).toBeNull();
  });
});

describe("the lead explained", () => {
  const i = { company: "Northwind Solar", signal: "A power trader invited bids for a 3.45 MW rooftop project", entity: "Contoso Power", reasons: ["makes inverters"], opportunity: "Solar tender" };
  it("keeps short answers that use only the facts' numbers and promise nothing", () => {
    const ok = { why: "Northwind makes inverters, which the 3.45 MW rooftop project needs.", play: "Reach the EPC firms bidding before they pick suppliers.", next: "Ask the bidders who is choosing inverters." };
    expect(parseExplain(JSON.stringify(ok), i)).toEqual(ok);
    expect(parseExplain(JSON.stringify({ ...ok, why: "A 12 MW order is coming." }), i)).toBeNull();
    expect(parseExplain(JSON.stringify({ ...ok, play: "They will win this for sure, guaranteed." }), i)).toBeNull();
    expect(parseExplain("not json", i)).toBeNull();
  });
});
