import { describe, it, expect } from "vitest";
import { loadPackFromDir, FIXTURE_PACK_DIR } from "@tell/config";
import { compileGigRules, gigVerdict, gigDedupeKey, type GigPosting } from "./gigs.js";

const rules = compileGigRules((await loadPackFromDir(FIXTURE_PACK_DIR)).gigs);
const now = new Date(Date.UTC(2026, 10, 12));
const g = (o: Partial<GigPosting>): GigPosting => ({ source: "remoteok", externalId: "1", title: "HubSpot Consultant", url: "https://remoteok.com/1", tags: [], employmentType: "Contractor", postedAt: new Date(now.getTime() - 2 * 86_400_000), ...o });

describe("gig rules", () => {
  it("a recent contract HubSpot gig open worldwide is a gig", () => {
    expect(gigVerdict(g({ location: "Worldwide" }), rules, now)).toEqual({ ok: true, reason: "gig" });
    expect(gigVerdict(g({ location: "" }), rules, now).ok).toBe(true);
  });
  it("full-time roles are not gigs, unless the text says contract", () => {
    expect(gigVerdict(g({ employmentType: "Full Time" }), rules, now)).toMatchObject({ ok: false, reason: "not contract/freelance" });
    expect(gigVerdict(g({ employmentType: "Full Time", title: "Freelance HubSpot Consultant" }), rules, now).ok).toBe(true);
  });
  it("matches on tags when the title is vague", () => {
    expect(gigVerdict(g({ title: "Systems Specialist", tags: ["hubspot", "contract"] }), rules, now).ok).toBe(true);
  });
  it("false-positive classes: contract engineering, commission-only sales, recruiters, other work", () => {
    expect(gigVerdict(g({ title: "Contract Backend Engineer (CRM integrations)" }), rules, now).reason).toBe("excluded title");
    expect(gigVerdict(g({ title: "Commission-only HubSpot Sales Rep" }), rules, now).reason).toBe("excluded title");
    expect(gigVerdict(g({ title: "Recruiter for GTM roles" }), rules, now).reason).toBe("excluded title");
    expect(gigVerdict(g({ title: "Contract Video Editor" }), rules, now).reason).toBe("not your kind of work");
  });
  it("location-restricted gigs are dropped unless open to you", () => {
    expect(gigVerdict(g({ location: "USA only" }), rules, now).reason).toBe("not open to your location");
    expect(gigVerdict(g({ location: "Anywhere in the world" }), rules, now).ok).toBe(true);
  });
  it("old or expired gigs are dropped", () => {
    expect(gigVerdict(g({ postedAt: new Date(now.getTime() - 30 * 86_400_000) }), rules, now).reason).toBe("too old");
    expect(gigVerdict(g({ expiresAt: new Date(now.getTime() - 1) }), rules, now).reason).toBe("expired");
  });
  it("same gig on two boards has one dedupe key", () => {
    expect(gigDedupeKey("Acme Inc", "HubSpot Consultant (Contract)")).toBe(gigDedupeKey("acme inc", "HubSpot consultant"));
  });
});
