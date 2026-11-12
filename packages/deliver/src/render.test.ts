import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { ScoreRunResult } from "@tell/pipeline";
import type { AccountScore, Evidence } from "@tell/intel";
import { renderDigest, describe as describeEvidence } from "./render.js";
import { buildMime } from "./gmail.js";

const pack = await loadFixturePack();
const ev = (o: Partial<Evidence>): Evidence => ({ type: "core_role_open_45d", class: "implicit", ageDays: 0, current: true, openDays: 120, quote: "GTM Engineer", url: "https://jobs.example/1", ref: { kind: "job", id: "j1" }, ...o });
const score = (o: Partial<AccountScore> = {}): AccountScore => ({
  intent: 0.5, fit: 0.9, timing: 1, priority: 0.45, lane: "combined", eligible: true,
  evidence: [ev({})], drivers: [ev({}), ev({ type: "first_role", quote: "Founding <AE>", openDays: 5 })],
  plays: [{ id: "struggling_to_hire", title: "Struggling to hire ops", angle: "Bridge while they hire.", evidence: [ev({})] }], ...o,
});
const result = (leads: number): ScoreRunResult => ({
  configVersion: "example-gtm@abc", scored: 10, eligible: 9, playsMatched: 3, personLeads: [],
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

describe("MIME", () => {
  it("builds a multipart message with encoded non-ASCII headers", () => {
    const m = buildMime({ from: "a@x.com", fromName: "Lead digest", to: "b@y.com", subject: "Leads — today", html: "<b>hi</b>", text: "hi" }, "BOUND");
    expect(m).toContain('Content-Type: multipart/alternative; boundary="BOUND"');
    expect(m).toMatch(/Subject: =\?UTF-8\?B\?.+\?=/);
    expect(m).toContain("--BOUND--");
  });
});
