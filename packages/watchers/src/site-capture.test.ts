import { describe, it, expect } from "vitest";
import { extractSiteFacts } from "./site.js";

describe("site facts: forms, partner badges, agency credits", () => {
  it("finds forms that post to email or form tools", () => {
    const f = extractSiteFacts(`<form action="https://formspree.io/f/abc"><input name="email"></form><form action="mailto:hi@acme.test"><textarea></textarea></form>`, []);
    expect(f.leakyForms.sort()).toEqual(["formspree", "mailto"]);
    expect(f.hasForm).toBe(true);
  });
  it("a form posting to its own backend isn't leaky", () => {
    const f = extractSiteFacts(`<form action="/api/contact"><input name="email"></form>`, []);
    expect(f.leakyForms).toEqual([]);
    expect(f.hasForm).toBe(true);
  });
  it("spots a partner badge and an agency credit in the footer", () => {
    const f = extractSiteFacts(`<body><p>We help B2B teams.</p><img alt="HubSpot Solutions Partner"><footer>Growth partner: Northwind Studio</footer></body>`, []);
    expect(f.partnerBadge).toBe(true);
    expect(f.agencyCredit).toBe("Northwind Studio");
  });
});
