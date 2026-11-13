import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { ScoreRunResult } from "@tell/pipeline";
import type { AccountScore, Evidence } from "@tell/intel";
import { renderDigest, opener, leadSheetRow, describe as describeEvidence } from "./render.js";
import { LEAD_COLUMNS } from "./sheets.js";
import { buildMime } from "./gmail.js";

const pack = await loadFixturePack();
const ev = (o: Partial<Evidence>): Evidence => ({ type: "core_role_open_45d", class: "implicit", ageDays: 0, current: true, openDays: 120, quote: "GTM Engineer", url: "https://jobs.example/1", ref: { kind: "job", id: "j1" }, ...o });
const score = (o: Partial<AccountScore> = {}): AccountScore => ({
  intent: 0.5, fit: 0.9, timing: 1, priority: 0.45, lane: "combined", eligible: true,
  evidence: [ev({})], drivers: [ev({}), ev({ type: "first_role", quote: "Founding <AE>", openDays: 5 })],
  plays: [{ id: "struggling_to_hire", title: "Struggling to hire ops", angle: "Bridge while they hire.", evidence: [ev({})] }], ...o,
});
const result = (leads: number): ScoreRunResult => ({
  configVersion: "example-gtm@abc", scored: 10, eligible: 9, playsMatched: 3, criticDropped: {}, personLeads: [],
  ranking: {
    leads: Array.from({ length: leads }, (_, i) => ({ account: { id: `a${i}`, domain: `acme${i}.com`, name: `Acme ${i}`, sizeBand: "2-10", region: "India", segment: "b2b" }, score: score(), incomplete: false, recentlyDelivered: false, newPlaySinceDelivery: false })),
    watchlist: [], held: { incomplete: 0, recentlyDelivered: 0 },
  },
});
const health = { boardsChecked24h: 100, boardsTotal: 100, boardsFailing: 0, ticks24h: 48, tickErrors24h: 0, haikuTodayUsd: 0.01, haikuCapUsd: 0.5 };

describe("digest render", () => {
  it("writes 'why now' lines from evidence", () => {
    expect(describeEvidence(ev({}))).toBe('"GTM Engineer" open 4 months');
    expect(describeEvidence(ev({ type: "explicit_hire_request", quote: "need a HubSpot freelancer" }))).toBe('Asked for help: "need a HubSpot freelancer"');
  });
  it("subject names the top leads; html escapes scraped text; links cite evidence", () => {
    const e = renderDigest(result(3), pack, health, "2026-11-12");
    expect(e.subject).toBe("3 leads for 2026-11-12: Acme 0, Acme 1, Acme 2");
    expect(e.html).toContain("Founding &lt;AE&gt;");
    expect(e.html).not.toContain("Founding <AE>");
    expect(e.html).toContain('href="https://jobs.example/1"');
    expect(e.text).toContain("Angle: Bridge while they hire.");
  });
  it("never pads; flags a quiet schedule in health", () => {
    const e = renderDigest(result(0), pack, { ...health, ticks24h: 3 }, "2026-11-12");
    expect(e.subject).toBe("No new leads for 2026-11-12");
    expect(e.text).toContain("expected about 48: check the schedule");
  });
});

describe("people-first digest", () => {
  const contact = { person: { name: "Riya Sample", role: "Founder/CEO", linkedin: "https://linkedin.com/in/riya", source: "yc" }, persona: "Founder / CEO", note: "Founder / CEO" };
  it("opener names the person and the evidence", () => {
    expect(opener(contact, "Bluejay", ev({ openDays: 120 }))).toBe('Hi Riya, saw Bluejay has had a "GTM Engineer" role open for 4 months.');
    expect(opener(null, "Bluejay", ev({ type: "first_role", quote: "Founding AE" }))).toBe('Saw Bluejay is making a founding GTM hire ("Founding AE").');
  });
  it("leads are headed by the person, with links; subject names people", () => {
    const e = renderDigest(result(1), pack, health, "2026-11-12", new Map([["a0", contact]]));
    expect(e.subject).toBe("1 person to contact for 2026-11-12: Riya at Acme 0");
    expect(e.html).toContain("Riya Sample");
    expect(e.html).toContain('href="https://linkedin.com/in/riya"');
    expect(e.text).toContain("Opener: Hi Riya, saw Acme 0 has had");
  });
  it("says so when no contact is known", () => {
    expect(renderDigest(result(1), pack, health, "2026-11-12", new Map()).text).toContain("no contact found yet");
  });
});

describe("freelance gigs section", () => {
  it("lists gigs with apply links and source attribution (Remote OK / Himalayas terms)", () => {
    const gig = { id: "g1", source: "himalayas", title: "Fractional RevOps Lead", company: "Acme", url: "https://himalayas.app/companies/acme/jobs/x", applyUrl: "https://himalayas.app/companies/acme/jobs/x/apply", employmentType: "Contractor", location: "Worldwide", postedAt: null };
    const e = renderDigest(result(1), pack, health, "2026-11-12", undefined, [gig]);
    expect(e.subject).toContain("+ 1 gig");
    expect(e.html).toContain('href="https://himalayas.app/companies/acme/jobs/x/apply"');
    expect(e.html).toContain('via <a href="https://himalayas.app/companies/acme/jobs/x"');
    expect(e.text).toContain("via Himalayas");
  });
});

describe("sheet row", () => {
  it("has one value per column except the hidden ID, leaves your columns empty, names the person", () => {
    const contact = { person: { name: "Riya Sample", role: "Founder/CEO", linkedin: "https://linkedin.com/in/riya", source: "yc" }, persona: "Founder / CEO", note: "" };
    const row = leadSheetRow(result(1).ranking.leads[0]!, contact, "2026-11-13");
    expect(row).toHaveLength(LEAD_COLUMNS.length - 1);
    const col = (c: (typeof LEAD_COLUMNS)[number]) => row[LEAD_COLUMNS.indexOf(c)];
    expect(col("Person")).toBe("Riya Sample");
    expect(col("Opener")).toContain("Hi Riya");
    expect([col("Label"), col("Reason"), col("Outcome"), col("Notes")]).toEqual(["", "", "", ""]);
  });
});

describe("non-hiring signal wording", () => {
  const c = { person: { name: "Riya S", role: "CEO", source: "yc" }, persona: "Founder / CEO", note: "" };
  it.each([
    [ev({ type: "funding_raise", quote: "Acme lands $3M seed" }), 'Hi Riya, congrats on the raise ("Acme lands $3M seed").'],
    [ev({ type: "cta_sales_led", quote: 'Homepage now says "Book a demo" (was self-serve)' }), 'Hi Riya, saw Acme just switched its site to sales-led ("Book a demo" (was self-serve)).'],
    [ev({ type: "gtm_tool_added", quote: "Added HubSpot (website)" }), "Hi Riya, saw Acme just added HubSpot."],
    [ev({ type: "stack_sprawl", quote: "5 GTM tools: HubSpot, Intercom, Segment, Apollo, Calendly" }), "Hi Riya, noticed Acme runs 5 GTM tools."],
  ])("%#", (e, want) => expect(opener(c, "Acme", e)).toBe(want));
});

describe("people beyond founders", () => {
  it("names people found for other personas and drops their search link", () => {
    const contact = {
      person: { name: "Riya S", role: "Founder/CEO", source: "yc" }, persona: "Founder / CEO", note: "",
      others: [{ persona: "RevOps lead", person: { name: "Jane Doe", role: "Head of Revenue Operations at Acme 0", linkedin: "https://www.linkedin.com/in/jane", source: "exa" } }],
    };
    const e = renderDigest(result(1), pack, health, "2026-11-13", new Map([["a0", contact]]));
    expect(e.html).toContain('<a href="https://www.linkedin.com/in/jane"');
    expect(e.text).toContain("Also: Jane Doe, Head of Revenue Operations at Acme 0");
    expect(e.text).not.toContain("Also reach RevOps lead");
    expect(e.text).toContain("Also reach Head of GTM / Revenue");
  });
});

describe("MIME", () => {
  it("builds a multipart message with encoded non-ASCII headers", () => {
    const m = buildMime({ from: "a@x.com", fromName: "Lead digest", to: "b@y.com", subject: "Leads — today", html: "<b>hi</b>", text: "hi" }, "BOUND");
    expect(m).toContain('Content-Type: multipart/alternative; boundary="BOUND"');
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
    expect(m).toContain("--BOUND--");
  });
});

describe("analyst notes in the digest", () => {
  it("uses the analyst opener with a code-written greeting, else falls back", async () => {
    const { leadOpener } = await import("./render.js");
    const c = { person: { name: "Ravi Tannery", role: "CEO", source: "yc" }, persona: "Founder", note: "" };
    const n = { hypothesis: "h", angle: "a", opener: "Saw the founding AE role.", counterEvidence: null, confidence: 0.6 };
    expect(leadOpener(c, "Tanmark", undefined, n)).toBe("Hi Ravi, saw the founding AE role.");
    expect(leadOpener(null, "Tanmark", undefined, n)).toBe("Saw the founding AE role.");
    expect(leadOpener(c, "Tanmark", undefined, undefined)).toBeNull();
    expect(leadOpener(c, "Tanmark", undefined, { ...n, opener: "I saw Tanmark is hiring." })).toBe("Hi Ravi, I saw Tanmark is hiring.");
    expect(leadOpener(c, "Tanmark", undefined, { ...n, opener: "Tanmark's AE role caught my eye." })).toBe("Hi Ravi, Tanmark's AE role caught my eye.");
  });
});
