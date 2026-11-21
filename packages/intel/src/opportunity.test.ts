import { describe, it, expect } from "vitest";
import { rosterFromAwards, expiringEvents, matchEvent, matchValue, scoreBeneficiary, heldBack, timingFor, eventQuote, sameEntity, entityKey, affiliates, type AwardLike } from "./opportunity.js";

const NOW = new Date("2026-11-21T00:00:00Z");
const d = (s: string) => new Date(`${s}T00:00:00Z`);
let n = 0;
const award = (o: Partial<AwardLike>): AwardLike => ({
  awardId: `A${++n}`, recipient: "NORTHWIND SYSTEMS INC", uei: "UEI1", amount: 2_000_000, startDate: d("2025-03-01"), endDate: d("2027-06-30"),
  agency: "Department of Veterans Affairs", subAgency: "Veterans Health Administration", naics: "541512", description: "IT modernization support",
  state: "VA", setAside: null, url: `https://www.usaspending.gov/award/A${n}`, ...o,
});

describe("roster from awards", () => {
  it("one member per company, set-aside family carried by the same award found twice, under min_awards left out", () => {
    const a1 = award({}), dup = { ...a1, setAside: "8a" }, a2 = award({ subAgency: "Office of Information and Technology" });
    const one = award({ recipient: "TAILSPIN LLC", uei: "UEI9" });
    const r = rosterFromAwards([a1, dup, a2, one], 2);
    expect(r).toHaveLength(1);
    expect(r[0]!.facts.awards).toBe(2);
    expect(r[0]!.facts.setAsides).toEqual(["8a"]);
    expect(r[0]!.facts.naics).toEqual({ "541512": 2 });
    expect(r[0]!.name).toBe("Northwind Systems INC");
    expect(r[0]!.key).toBe(entityKey("NORTHWIND SYSTEMS INC"));
    expect(r[0]!.facts.evidence[0]!.quote).toMatch(/^Won \$2\.0M from Department of Veterans Affairs/);
  });
});

describe("small businesses only", () => {
  it("drops a company that never won a set-aside (the primes that win everything)", () => {
    const big = [award({ recipient: "BIGPRIME CORP", uei: "B" }), award({ recipient: "BIGPRIME CORP", uei: "B" })];
    const small = [award({ recipient: "TAILSPIN LLC", uei: "T", setAside: "wosb" }), award({ recipient: "TAILSPIN LLC", uei: "T" })];
    expect(rosterFromAwards([...big, ...small], 2, { smallBusinessOnly: true }).map((m) => m.name)).toEqual(["Tailspin LLC"]);
    expect(rosterFromAwards([...big, ...small], 2)).toHaveLength(2);
  });
});

describe("expiring events", () => {
  it("keeps ends inside the window over the minimum", () => {
    const evs = expiringEvents([
      award({ recipient: "CONTOSO FEDERAL LLC", endDate: d("2027-06-30") }),
      award({ endDate: d("2026-12-01") }), // 10 days: too close
      award({ endDate: d("2028-06-01") }), // too far
      award({ amount: 50_000 }),
      award({ recipient: "TASK ORDER CO", parent: "GS35F0001X" }), // an order under a vehicle: holders only
    ], { minDays: 90, maxDays: 365, minAmount: 1_000_000 }, NOW);
    expect(evs.map((e) => e.entityName)).toEqual(["Contoso Federal LLC"]);
    expect(eventQuote(evs[0]!)).toBe(`Contoso Federal LLC's $2.0M Department of Veterans Affairs (Veterans Health Administration) contract for "it modernization support" (NAICS 541512) ends 2027-06-30`);
  });
});

describe("match", () => {
  const ev = expiringEvents([award({ recipient: "CONTOSO FEDERAL LLC", uei: "UEIX", amount: 8_000_000, setAside: "8a" })], { minDays: 90, maxDays: 365, minAmount: 0 }, NOW)[0]!;
  const member = (o: Partial<ReturnType<typeof rosterFromAwards>[number]["facts"]> = {}, name = "Northwind Systems Inc") => ({
    key: entityKey(name), name,
    facts: { naics: { "541512": 3 }, agencies: { "Department of Veterans Affairs": 2 }, subAgencies: { "Veterans Health Administration": 2 }, setAsides: ["8a"], awards: 3, total: 9e6, largest: 4e6, lastAwardAt: "2026-01-01", ueis: ["UEI1"], states: [], evidence: [], ...o },
  });
  it("the incumbent never matches its own event (key, UEI, or the same name with another suffix)", () => {
    expect(matchEvent(ev, member({}, "Contoso Federal LLC"))).toBeNull();
    expect(matchEvent(ev, member({ ueis: ["UEIX"] }))).toBeNull();
    expect(matchEvent(ev, member({}, "Contoso Federal, Inc."))).toBeNull();
    expect(sameEntity("CONTOSO FEDERAL LLC", "Contoso Federal, Inc.")).toBe(true);
  });
  it("sister companies under one parent are the incumbent too; common first words are not a family", () => {
    expect(affiliates("Contoso Operations Services LLC", "Contoso IT Systems LLC")).toBe(true);
    expect(matchEvent(ev, member({}, "Contoso Data Group"))).toBeNull();
    expect(affiliates("Federal Data Systems", "Federal Data Partners")).toBe(false);
  });
  it("require_agency: no contract with the event's agency = no match", () => {
    expect(matchEvent(ev, member({ agencies: { "Department of Energy": 3 }, subAgencies: {} }), { requireAgency: true })).toBeNull();
    expect(matchEvent(ev, member({ agencies: { "Department of Energy": 3 }, subAgencies: {} }))).not.toBeNull();
  });
  it("set-aside is a hard gate", () => {
    expect(matchEvent(ev, member({ setAsides: [] }))).toBeNull();
    expect(matchEvent(ev, member({ setAsides: ["wosb"] }))).toBeNull();
  });
  it("NAICS: exact beats the same 4-digit industry; another industry never matches", () => {
    const exact = matchEvent(ev, member())!, near = matchEvent(ev, member({ naics: { "541511": 2 } }))!;
    expect(exact.fit).toBeGreaterThan(near.fit);
    expect(near.reasons[0]).toMatch(/same industry \(NAICS 5415\)/);
    expect(matchEvent(ev, member({ naics: { "236220": 5 } }))).toBeNull();
  });
  it("same sub-agency and big enough wins fit better", () => {
    const best = matchEvent(ev, member())!;
    const weak = matchEvent(ev, member({ agencies: {}, subAgencies: {}, largest: 100_000 }))!;
    expect(best.fit).toBe(1);
    expect(weak.fit).toBeLessThan(0.65);
    expect(best.reasons).toContain("has won 8(a) set-asides");
  });
});

describe("score", () => {
  it("adds up readable parts; more and bigger matched events score higher; buyer unknown = half", () => {
    const one = scoreBeneficiary([{ fit: 1, amount: 2e6, endDate: d("2027-08-01") }], [180, 365], null, NOW);
    const three = scoreBeneficiary([1, 2, 3].map(() => ({ fit: 1, amount: 2e7, endDate: d("2027-08-01") })), [180, 365], 1, NOW);
    expect(three.score).toBeGreaterThan(one.score);
    expect(one.parts.buyer).toBe(8);
    expect(one.line).toBe(`Score ${one.score} = opportunity ${one.parts.opportunity} · fit 25 · timing 15 · buyer 8`);
    expect(three.score).toBeLessThanOrEqual(100);
  });
  it("an event far bigger than anything they won counts as 4x their largest win; a set-aside weighs more", () => {
    const end = d("2027-08-01");
    expect(matchValue({ fit: 1, amount: 1.5e9, endDate: end, largest: 1e6 })).toBe(matchValue({ fit: 1, amount: 4e6, endDate: end }));
    expect(matchValue({ fit: 1, amount: 4e6, endDate: end, setAside: true })).toBeGreaterThan(matchValue({ fit: 1, amount: 4e6, endDate: end }));
  });
  it("timing: full in the sweet spot, lower when late or early, 0 once ended", () => {
    expect(timingFor(d("2027-08-01"), [180, 365], NOW)).toBe(1);
    expect(timingFor(d("2027-01-15"), [180, 365], NOW)).toBeLessThan(1);
    expect(timingFor(d("2028-06-01"), [180, 365], NOW)).toBeLessThan(1);
    expect(timingFor(d("2026-01-01"), [180, 365], NOW)).toBe(0);
  });
  it("held back after delivery unless one of its top events is new to you", () => {
    expect(heldBack(d("2026-11-10"), false, 30, NOW)).toBe(true);
    expect(heldBack(d("2026-11-10"), true, 30, NOW)).toBe(false);
    expect(heldBack(d("2026-09-01"), false, 30, NOW)).toBe(false);
    expect(heldBack(null, false, 30, NOW)).toBe(false);
  });
});

import { matchGeneral, generalFacts, mentionsAny } from "./opportunity.js";
describe("news and signal events", () => {
  const ev = { key: "u1", entityName: "Contoso Pharma Ltd", entityKey: entityKey("Contoso Pharma Ltd"), region: "India", quote: "Contoso Pharma to set up plant on 40 acres in Gujarat", url: "https://news.example/1", strength: 4, observedAt: NOW };
  const m = (name: string, region: string | null, description = "tablet press and granulation equipment maker") => ({ key: entityKey(name), name, facts: generalFacts({ description, region, found: "q", website: "https://x.example" }), accountId: `acc-${name}` });
  it("the company in the news never benefits from its own event, nor its sister companies", () => {
    expect(matchGeneral(ev, m("Contoso Pharma Limited", "India"))).toBeNull();
    expect(matchGeneral(ev, m("Contoso Engineering", "India"))).toBeNull();
    expect(matchGeneral({ ...ev, entityAccountId: "acc-Fabrikam Machines" }, m("Fabrikam Machines", "India"))).toBeNull();
  });
  it("region: the event's own unless the opportunity names others; unknown HQ never matches", () => {
    expect(matchGeneral(ev, m("Fabrikam Machines", "India"))).not.toBeNull();
    expect(matchGeneral(ev, m("Fabrikam Machines", "United States of America"))).toBeNull();
    expect(matchGeneral(ev, m("Fabrikam Machines", null))).toBeNull();
    expect(matchGeneral({ ...ev, region: "United States of America" }, m("Fabrikam Machines", "India"), { regions: ["India"] })).not.toBeNull();
  });
  it("fit is higher when their description names what the opportunity needs", () => {
    const hit = matchGeneral(ev, m("Fabrikam Machines", "India"), { keywords: ["granulation"] })!;
    const miss = matchGeneral(ev, m("Fabrikam Machines", "India", "general engineering works"), { keywords: ["granulation"] })!;
    expect(hit.fit).toBe(1); expect(hit.reasons).toContain("offers granulation");
    expect(miss.fit).toBe(0.6);
    expect(mentionsAny("API maker", ["api"])).toBe("api");
    expect(mentionsAny("rapid growth", ["api"])).toBeNull();
  });
  it("news events score on strength and freshness", () => {
    const fresh = scoreBeneficiary([{ fit: 1, amount: 0, endDate: NOW, strength: 4, observedAt: NOW }], [0, 0], null, NOW);
    const old = scoreBeneficiary([{ fit: 1, amount: 0, endDate: d("2026-10-01"), strength: 4, observedAt: d("2026-10-01") }], [0, 0], null, NOW);
    expect(fresh.parts.timing).toBe(15);
    expect(old.parts.timing).toBeLessThan(3);
  });
});

import { isJointVenture } from "./opportunity.js";
describe("joint ventures", () => {
  it("are left off rosters (no site of their own: a name search lands on another brand)", () => {
    expect(isJointVenture("LITWARE JV, LLP")).toBe(true);
    expect(isJointVenture("Acme-Beta Joint Venture")).toBe(true);
    expect(isJointVenture("Acme Mentor-Protege JV II")).toBe(true);
    expect(isJointVenture("Jvion Systems Inc")).toBe(false);
    const a = (r: string) => ({ awardId: `${r}${Math.random()}`, recipient: r, uei: null, amount: 1e6, startDate: null, endDate: null, agency: "A", subAgency: "", naics: "236220", description: "x", state: null, setAside: "8a", url: "u" });
    expect(rosterFromAwards([a("LITWARE JV, LLP"), a("LITWARE JV, LLP")], 2)).toEqual([]);
  });
});
