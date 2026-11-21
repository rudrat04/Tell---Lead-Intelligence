import { describe, it, expect } from "vitest";
import { loadFixturePack, type Pack } from "@tell/config";
import { matchPlays, scoreAccount, industryEvidence, type Evidence } from "./rank.js";

// One industry gets the signals that are necessary and enough to make it an offer, and nothing from another
// industry leaks in: a SaaS hiring play never fires on a drug maker, a drug-shortage play never on a SaaS company.
const base = await loadFixturePack();
const ind = (label: string, signals: string[]) => ({ label, aliases: [], description: `${label} companies`, buyers: [], list: "manual" as const, excluded: false, signals });
const gtm = ["core_role_open_45d", "core_role_filled", "funding_raise", "first_role"];
const pack: Pack = {
  ...base,
  icp: { ...base.icp, industries: { software: ind("Software", gtm), pharma: ind("Pharma", ["shortage_anda_dormant"]) } },
  signals: { ...base.signals, signals: { ...base.signals.signals, shortage_anda_dormant: { class: "implicit", lr: 6, half_life_days: 60, strength: 5, fast_lane: false } } },
  plays: { ...base.plays, plays: {
    struggling_to_hire: { ...base.plays.plays.struggling_to_hire!, industries: ["software"] },
    shortage_relaunch: { title: "Shortage drug", requires: ["shortage_anda_dormant"], requires_any: [], absent: [], window_days: 120, angle: "a", min_count: {}, qualifies: true, personas: [], industries: ["pharma"] },
    explicit_ask: { ...base.plays.plays.explicit_ask!, industries: [] },
  } },
};
let n = 0;
const e = (type: string, cls = "implicit", ageDays = 0): Evidence => ({ type, class: cls, ageDays, current: ageDays === 0, quote: `${type} quote`, url: `https://x.test/${n++}`, ref: { kind: "signal", id: `s${n}` } });
const shortage = e("shortage_anda_dormant"), hiring = e("core_role_open_45d"), filled = e("core_role_filled", "negative", 3);

describe("industry scope", () => {
  it("a scoped play fires only in its industry, never on an unknown one", () => {
    expect(matchPlays([shortage], pack.plays.plays, "pharma").map((p) => p.id)).toEqual(["shortage_relaunch"]);
    expect(matchPlays([shortage], pack.plays.plays, "software")).toEqual([]);
    expect(matchPlays([shortage], pack.plays.plays, null)).toEqual([]);
    expect(matchPlays([hiring], pack.plays.plays, "pharma")).toEqual([]);
  });
  it("an unscoped play fires anywhere, unknown industry included", () => {
    const ask = e("explicit_hire_request", "explicit");
    for (const seg of ["software", "pharma", null]) expect(matchPlays([ask], pack.plays.plays, seg).map((p) => p.id)).toEqual(["explicit_ask"]);
  });
  it("only the industry's own signals count (negatives always do); unknown industry = all", () => {
    expect(industryEvidence([shortage, hiring, filled], "pharma", pack).map((x) => x.type)).toEqual(["shortage_anda_dormant", "core_role_filled"]);
    expect(industryEvidence([shortage, hiring], "software", pack).map((x) => x.type)).toEqual(["core_role_open_45d"]);
    expect(industryEvidence([shortage, hiring], null, pack)).toHaveLength(2);
  });
  it("a sales hire at a drug maker doesn't make a lead or reach the evidence", () => {
    const s = scoreAccount([hiring], { sizeBand: "11-50", region: null, segment: "pharma" }, pack);
    expect(s.evidence).toEqual([]);
    expect(s.plays).toEqual([]);
    expect(s.eligible).toBe(false);
    const ok = scoreAccount([shortage, hiring], { sizeBand: "11-50", region: null, segment: "pharma" }, pack);
    expect(ok.plays.map((p) => p.id)).toEqual(["shortage_relaunch"]);
    expect(ok.evidence.map((x) => x.type)).toEqual(["shortage_anda_dormant"]);
  });
  it("judged mode: an industry with no free step on offer is never a lead", () => {
    const cap = (id: string, industries: string[]) => ({ id, name: id, deliver: "something useful", free: true, good_for: "", industries });
    const judged: Pack = { ...pack, signals: { ...pack.signals, score: { ...pack.signals.score, mode: "judged" } }, capabilities: { capabilities: [cap("list_federal_buyers", ["pharma"])] } };
    const facts = (segment: string | null) => ({ sizeBand: "11-50", region: null, segment });
    expect(scoreAccount([shortage], facts("pharma"), judged).needsJudge).toBe(true);
    const sw = scoreAccount([hiring], facts("software"), judged);
    expect(sw.eligible).toBe(false);
    expect(sw.needsJudge).toBeUndefined();
    expect(scoreAccount([e("explicit_hire_request", "explicit")], facts(null), judged).eligible).toBe(false);
  });
});
