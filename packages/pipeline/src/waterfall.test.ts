import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { parseHunterDomain } from "@tell/watchers";
import { enrichStatus, domainPeople } from "./waterfall.js";

describe("Enrich email cell", () => {
  it("is a short status after the click (the address goes in Email only when verified); suppressed never shows anything", () => {
    expect(enrichStatus({ address: "mila@acme.test", status: "verified", note: "verified (QuickEmailVerification)" })).toBe("done: verified (QuickEmailVerification)");
    expect(enrichStatus({ address: "mila@acme.test", status: "verified", note: "found by Hunter (score 97)" })).toBe("done: verified (Hunter)");
    expect(enrichStatus({ address: "mila@acme.test", status: "observed", note: "seen in public" })).toBe("done: verified (published)");
    expect(enrichStatus(null, false, { catchAll: true })).toBe("no verified address (catch-all domain)");
    expect(enrichStatus(null, false, { email: { status: "invalid" } })).toBe("no deliverable address");
    expect(enrichStatus(null)).toBe("not found");
    expect(enrichStatus({ address: "mila@acme.test", status: "verified", note: "" }, true)).toBe("suppressed (do not contact)");
  });
});

describe("people from Hunter's domain search", () => {
  it("named people only, verified addresses ride along; titles that match a buyer and name no other company", async () => {
    const pack = await loadFixturePack();
    const r = parseHunterDomain({ data: { accept_all: false, emails: [
      { value: "Mila@acme.test", type: "personal", first_name: "Mila", last_name: "Osk", position: "Founder & CEO", linkedin: "https://www.linkedin.com/in/mila", verification: { status: "valid" } },
      { value: "info@acme.test", type: "generic", first_name: null },
      { value: "jo@acme.test", type: "personal", first_name: "Jo", last_name: "Lee", position: "Software Engineer", verification: { status: "accept_all" } },
      { value: "ana@acme.test", type: "personal", first_name: "Ana", last_name: "Ray", position: "Founder | Studio Harbor Design", verification: { status: "valid" } },
    ] } });
    expect(r.people.map((p) => p.address)).toEqual(["mila@acme.test", "jo@acme.test", "ana@acme.test"]);
    const ps = domainPeople(r.people, pack, "Acme", "acme.test");
    expect(ps.map((p) => p.name)).toEqual(["Mila Osk"]);
    expect(ps[0]!.email).toEqual({ address: "mila@acme.test", status: "verified", note: "verified (Hunter)" });
  });
});
