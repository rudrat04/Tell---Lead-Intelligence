import { describe, it, expect } from "vitest";
import { loadFixturePack, type Pack } from "@tell/config";
import { compileRoles } from "./jobs.js";
import { buildEvidence, matchPlays, scoreAccount, type JobRow, type SignalRow } from "./rank.js";
import { emailAuthGap, attributionGap, siteHealthPoor, diffSite, diffDnsTools, compileTools, type SiteState } from "./watch.js";

const base = await loadFixturePack();
const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 10, 15));
const ago = (d: number) => new Date(now.getTime() - d * DAY);

// the fixture pack plus the optional types and plays built in Nov 2026
const pack: Pack = {
  ...base,
  signals: { ...base.signals, signals: {
    ...base.signals.signals,
    freeze_to_contract: { class: "explicit", lr: 8, half_life_days: 21, strength: 5, fast_lane: true, max_events: 1 },
    email_auth_gap: { class: "implicit", lr: 2.5, half_life_days: 60, strength: 3, fast_lane: false, max_events: 1 },
    content_motion: { class: "trigger", lr: 1.8, half_life_days: 45, strength: 3, fast_lane: false },
    leaky_capture: { class: "implicit", lr: 2.5, half_life_days: 120, strength: 3, fast_lane: false, max_events: 1 },
  } },
  plays: { ...base.plays, plays: {
    ...base.plays.plays,
    attention_no_capture: { title: "Attention, nowhere to land", requires: ["leaky_capture"], requires_any: ["content_motion", "product_launch", "funding_raise"], absent: [], window_days: 60, angle: "a", min_count: {}, qualifies: true, personas: [], industries: [] },
    freeze_to_contract: { title: "Couldn't hire", requires: ["freeze_to_contract"], requires_any: [], absent: ["core_role_filled"], window_days: 45, angle: "b", min_count: {}, qualifies: true, personas: [], industries: [] },
  } },
};
const roles = compileRoles(pack.roles);

let n = 0;
const job = (title: string, posted: number, o: Partial<JobRow> = {}): JobRow =>
  ({ id: `j${++n}`, title, url: `https://jobs.example/${n}`, employmentType: null, family: "x", postedAt: ago(posted), firstSeenAt: ago(posted), closedAt: null, ...o });
const sig = (type: string, days: number, o: Partial<SignalRow> = {}): SignalRow =>
  ({ id: `s${++n}`, type, evidenceQuote: "q", evidenceUrl: `https://news.example/${n}`, observedAt: ago(days), ...o });
const ev = (jobs: JobRow[], signals: SignalRow[] = []) => buildEvidence(jobs, signals, pack, roles, now);

describe("hiring freeze turned contract", () => {
  it("a core role removed after 90 days, then a contract version 10 days later", () => {
    const e = ev([job("RevOps Manager", 120, { closedAt: ago(30) }), job("RevOps Contractor", 20, { employmentType: "Contract" })]);
    const f = e.find((x) => x.type === "freeze_to_contract")!;
    expect(f.quote).toBe('Removed "RevOps Manager" after 90 days unfilled; 10 days later posted "RevOps Contractor"');
    expect(f.current).toBe(true);
    expect(scoreAccount(e, { sizeBand: "11-50", region: null, segment: null }, pack).plays.map((p) => p.id)).toContain("freeze_to_contract");
  });
  it("a public ask for help after the close counts as the contract ask", () => {
    const e = ev([job("RevOps Manager", 120, { closedAt: ago(30) })], [sig("explicit_hire_request", 12, { evidenceQuote: "Looking for a freelance HubSpot consultant" })]);
    expect(e.some((x) => x.type === "freeze_to_contract")).toBe(true);
  });
  it("not when the role was removed fast (that's a fill), or the contract came first, or the role was a JSearch listing", () => {
    expect(ev([job("RevOps Manager", 40, { closedAt: ago(30) }), job("RevOps Contractor", 20, { employmentType: "Contract" })]).some((x) => x.type === "freeze_to_contract")).toBe(false);
    expect(ev([job("RevOps Manager", 120, { closedAt: ago(10) }), job("RevOps Contractor", 60, { employmentType: "Contract" })]).some((x) => x.type === "freeze_to_contract")).toBe(false);
    expect(ev([job("RevOps Manager", 120, { closedAt: ago(30), boardSource: "jsearch" }), job("RevOps Contractor", 20, { employmentType: "Contract" })]).some((x) => x.type === "freeze_to_contract")).toBe(false);
  });
  it("a contract *sales* role isn't the ask (only a contract version of the core role)", () => {
    expect(ev([job("RevOps Manager", 120, { closedAt: ago(30) }), job("Account Executive (Contract)", 20)]).some((x) => x.type === "freeze_to_contract")).toBe(false);
  });
});

describe("plays: requires_any", () => {
  const leak = { type: "leaky_capture", class: "implicit", ageDays: 0, current: true, quote: "leak", url: "u1", ref: { kind: "signal" as const, id: "1" } };
  const launch = { type: "product_launch", class: "trigger", ageDays: 10, current: false, quote: "Launched", url: "u2", ref: { kind: "signal" as const, id: "2" } };
  it("needs the required type and at least one of the listed ones, and cites both", () => {
    expect(matchPlays([leak], pack.plays.plays).map((p) => p.id)).not.toContain("attention_no_capture");
    const m = matchPlays([leak, launch], pack.plays.plays).find((p) => p.id === "attention_no_capture")!;
    expect(m.evidence.map((e) => e.type)).toEqual(["leaky_capture", "product_launch"]);
  });
  it("an attention signal outside the window doesn't count", () => {
    expect(matchPlays([leak, { ...launch, ageDays: 90 }], pack.plays.plays).map((p) => p.id)).not.toContain("attention_no_capture");
  });
});

describe("email authentication gap", () => {
  const spf = ["v=spf1 include:_spf.google.com ~all"];
  it("no DMARC record on a domain hiring SDRs", () => {
    expect(emailAuthGap("acme.test", spf, [], "Hiring 2 SDRs/BDRs", now)?.quote).toBe("Hiring 2 SDRs/BDRs, but acme.test has no DMARC record");
  });
  it("p=none is a record and meets the requirement: no signal", () => {
    expect(emailAuthGap("acme.test", spf, ["v=DMARC1; p=none; rua=mailto:d@acme.test"], "Runs Apollo", now)).toBeNull();
  });
  it("two SPF records, or +all, are flagged", () => {
    expect(emailAuthGap("acme.test", [...spf, "v=spf1 include:sendgrid.net ~all"], ["v=DMARC1; p=none"], "Runs Apollo", now)?.quote).toContain("2 SPF records");
    expect(emailAuthGap("acme.test", ["v=spf1 a mx +all"], ["v=DMARC1; p=none"], "Runs Apollo", now)?.quote).toContain("+all");
  });
  it("no outbound reason, or a failed lookup, says nothing", () => {
    expect(emailAuthGap("acme.test", spf, [], null, now)).toBeNull();
    expect(emailAuthGap("acme.test", spf, null, "Runs Apollo", now)).toBeNull();
    expect(emailAuthGap("acme.test", null, [], "Runs Apollo", now)).toBeNull();
  });
});

describe("attribution gap and site health", () => {
  it("a sales-led demo form with email and 4 fields but no source question", () => {
    expect(attributionGap("acme.test", true, [{ fields: 4, hasEmail: true, asksSource: false }], "https://acme.test/demo/", now)?.quote).toBe("Demo form asks for 4 details but never how the visitor heard about them (acme.test/demo)");
  });
  it("not when it asks, when it's a newsletter box, when the site isn't sales-led, or when no form is readable", () => {
    expect(attributionGap("acme.test", true, [{ fields: 4, hasEmail: true, asksSource: true }], "u", now)).toBeNull();
    expect(attributionGap("acme.test", true, [{ fields: 2, hasEmail: true, asksSource: false }], "u", now)).toBeNull();
    expect(attributionGap("acme.test", false, [{ fields: 4, hasEmail: true, asksSource: false }], "u", now)).toBeNull();
    expect(attributionGap("acme.test", true, [], "u", now)).toBeNull();
  });
  it("slow only when two runs in a row agree", () => {
    const slow = { score: 31, lcpMs: 6800, at: "x" }, fast = { score: 72, lcpMs: 2100, at: "y" };
    expect(siteHealthPoor("acme.test", [slow, { ...slow, score: 40 }], true, now)?.quote).toBe("Mobile PageSpeed 31/100, main content shows after 6.8s on mobile; no analytics tag on the homepage");
    expect(siteHealthPoor("acme.test", [slow, fast], false, now)).toBeNull();
    expect(siteHealthPoor("acme.test", [slow], false, now)).toBeNull();
  });
});

describe("site diff: content channels and analytics", () => {
  const rules = compileTools({ ...pack.tools, analytics_categories: ["analytics"], tools: { ...pack.tools.tools, ga4: { label: "Google Analytics", category: "analytics", site: [], dns: [] } } });
  const site = (o: Partial<SiteState> = {}): SiteState => ({ salesLed: false, selfServe: false, pricing: false, tools: [], contentLinks: [], ...o });
  it("a newly linked podcast is content_motion; a snapshot from before contentLinks existed is not", () => {
    expect(diffSite("acme.test", site(), site({ contentLinks: ["podcast"] }), rules, now).map((e) => e.quote)).toEqual(["Started linking a podcast from the homepage"]);
    expect(diffSite("acme.test", { salesLed: false, selfServe: false, pricing: false, tools: [] }, site({ contentLinks: ["blog"] }), rules, now)).toEqual([]);
  });
  it("adding analytics tools to the pack doesn't announce 'added Google Analytics' everywhere", () => {
    expect(diffSite("acme.test", site(), site({ tools: ["ga4"] }), rules, now)).toEqual([]);
    expect(diffDnsTools("acme.test", [], ["ga4"], rules, now)).toEqual([]);
  });
});
