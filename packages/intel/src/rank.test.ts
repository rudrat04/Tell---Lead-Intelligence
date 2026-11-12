import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { compileRoles } from "./jobs.js";
import { buildEvidence, scoreAccount, softFit, matchPlays, rankAccounts, type JobRow, type SignalRow, type AccountFacts } from "./rank.js";

const pack = await loadFixturePack();
const roles = compileRoles(pack.roles);
const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 10, 12));
const ago = (d: number) => new Date(now.getTime() - d * DAY);
const facts: AccountFacts = { sizeBand: "11-50", region: "United States of America", segment: "b2b" };

let n = 0;
const job = (title: string, posted: number | null, o: Partial<JobRow> = {}): JobRow =>
  ({ id: `j${++n}`, title, url: `https://jobs.example/${n}`, employmentType: null, family: "x", postedAt: posted == null ? null : ago(posted), firstSeenAt: now, closedAt: null, ...o });
const sig = (type: string, days: number, o: Partial<SignalRow> = {}): SignalRow =>
  ({ id: `s${++n}`, type, evidenceQuote: "q", evidenceUrl: `https://news.example/${n}`, observedAt: ago(days), ...o });

const score = (jobs: JobRow[], signals: SignalRow[] = [], f = facts) => scoreAccount(buildEvidence(jobs, signals, pack, roles, now), f, pack);

describe("job roles are state, not events", () => {
  it("a core role open for 7 months is current and scores high (the 'struggling to hire' case)", () => {
    const s = score([job("RevOps Manager", 210)]);
    expect(s.evidence[0]).toMatchObject({ type: "core_role_open_45d", ageDays: 0, current: true });
    expect(s.timing).toBe(1);
    expect(s.plays.map((p) => p.id)).toContain("struggling_to_hire");
    expect(s.eligible).toBe(true);
  });
  it("it outranks a company whose only evidence is an old adjacent role", () => {
    const struggling = score([job("GTM Engineer", 120)]);
    const oldSdr = score([job("SDR", 200)]);
    expect(struggling.priority).toBeGreaterThan(oldSdr.priority * 2);
  });
  it("an adjacent role decays while open, but never past 45 days of age", () => {
    const e = buildEvidence([job("SDR", 200)], [], pack, roles, now)[0]!;
    expect(e.ageDays).toBe(45);
  });
  it("a closed role ages from when it closed", () => {
    const e = buildEvidence([job("RevOps Lead", 100, { closedAt: ago(10) })], [], pack, roles, now)[0]!;
    expect(e).toMatchObject({ current: false, ageDays: 10 });
  });
});

describe("dedupe and caps", () => {
  it("the same role on YC and Ashby counts once", () => {
    const ev = buildEvidence([job("RevOps Manager", 60), job("RevOps Manager (Remote)", 50)], [], pack, roles, now);
    expect(ev).toHaveLength(1);
  });
  it("a hiring spree counts at most max_events_per_type roles of one type", () => {
    const many = score(["SDR", "SDR II", "BDR", "Account Executive", "Senior Account Executive", "Sales Development Rep"].map((t) => job(t, 5)));
    const three = score(["SDR", "BDR", "Account Executive"].map((t) => job(t, 5)));
    expect(many.intent).toBeCloseTo(three.intent, 10);
  });
  it("job-derived signal rows aren't double-counted with job state", () => {
    const withRow = score([job("RevOps Manager", 60)], [sig("core_role_open_45d", 15)]);
    const without = score([job("RevOps Manager", 60)]);
    expect(withRow.intent).toBeCloseTo(without.intent, 10);
  });
});

describe("signals, corroboration, lanes", () => {
  it("negative 'filled' signal lowers intent", () => {
    expect(score([job("SDR", 5)], [sig("core_role_filled", 3)]).intent).toBeLessThan(score([job("SDR", 5)]).intent);
  });
  it("a lone pain post is not corroborated (Gate 5) and not eligible", () => {
    const s = score([], [sig("pain_post", 2)]);
    expect(s.intent).toBeCloseTo(pack.signals.base_rate, 6);
    expect(s.eligible).toBe(false);
  });
  it("a pain post next to an open role counts", () => {
    expect(score([job("SDR", 5)], [sig("pain_post", 2)]).intent).toBeGreaterThan(score([job("SDR", 5)]).intent);
  });
  it("explicit hire requests and contract roles go to the fast lane", () => {
    expect(score([], [sig("explicit_hire_request", 3)]).lane).toBe("fast");
    expect(score([job("RevOps Consultant", 5, { employmentType: "Contract" })]).lane).toBe("fast");
    expect(score([job("SDR", 5)]).lane).toBe("combined");
  });
});

describe("fit, plays, ranking", () => {
  it("soft fit uses the pack weights and defaults", () => {
    expect(softFit(facts, pack.icp)).toBeCloseTo(0.5 * 1.0 + 0.3 * 1.0 + 0.2 * 1.0, 6);
    expect(softFit({ sizeBand: null, region: null, segment: null }, pack.icp)).toBeLessThan(softFit(facts, pack.icp));
  });
  it("plays need every required signal inside the window", () => {
    const ev = buildEvidence([job("Founding Account Executive", 10)], [], pack, roles, now);
    expect(matchPlays(ev, pack.plays.plays).map((p) => p.id)).toEqual(["first_gtm_hire"]);
  });
  it("orders by priority, guarantees fast-lane slots, never pads, holds back incomplete and recently delivered", () => {
    const mk = (name: string, sc: ReturnType<typeof score>, o: Partial<{ incomplete: boolean; recentlyDelivered: boolean; newPlaySinceDelivery: boolean }> = {}) =>
      ({ account: name, score: sc, incomplete: false, recentlyDelivered: false, newPlaySinceDelivery: false, ...o });
    const rows = [
      mk("combined-high", score([job("RevOps Manager", 90)])),
      mk("fast", score([], [sig("explicit_hire_request", 1)])),
      mk("not-eligible", score([], [sig("pain_post", 1)])),
      mk("outage", score([job("RevOps Lead", 90)]), { incomplete: true }),
      mk("sent-last-week", score([job("GTM Engineer", 90)]), { recentlyDelivered: true }),
      mk("sent-but-new-play", score([job("Sales Ops Manager", 90)]), { recentlyDelivered: true, newPlaySinceDelivery: true }),
    ];
    const r = rankAccounts(rows, 10);
    expect(r.leads.map((l) => l.account).sort()).toEqual(["combined-high", "fast", "sent-but-new-play"]);
    expect(r.leads.map((l) => l.score.priority)).toEqual([...r.leads.map((l) => l.score.priority)].sort((a, b) => b - a));
    expect(r.held).toEqual({ incomplete: 1, recentlyDelivered: 1 });
    // with one slot, a weak fresh fast-lane lead still gets in (guaranteed half the list, rounded up)
    expect(rankAccounts(rows, 1).leads.map((l) => l.account)).toEqual(["fast"]);
  });
});

describe("fixes from the first live ranking", () => {
  it("a contract sales hire is not a 'contract GTM role'; a contract RevOps role is", () => {
    expect(buildEvidence([job("Account Executive", 5, { employmentType: "Contract" })], [], pack, roles, now)[0]!.type).toBe("adjacent_role_open");
    expect(buildEvidence([job("RevOps Lead", 5, { employmentType: "Contract" })], [], pack, roles, now)[0]!.type).toBe("contract_role");
  });
  it("a stale strong signal is not fast lane", () => {
    expect(score([job("RevOps Consultant", 60, { employmentType: "Contract" })]).lane).toBe("combined");
    expect(score([job("RevOps Consultant", 5, { employmentType: "Contract" })]).lane).toBe("fast");
  });
  it("several founding roles are one 'building GTM from zero' story (first_role max_events: 1)", () => {
    const three = score([job("Founding Sales", 5), job("Founding GTM Lead", 5), job("Founding Account Executive", 5)]);
    const one = score([job("Founding Account Executive", 5)]);
    expect(three.intent).toBeCloseTo(one.intent, 10);
  });
  it("recruiter titles never count as GTM hires", () => {
    expect(buildEvidence([job("Founding GTM Recruiter", 5)], [], pack, roles, now)).toEqual([]);
  });
});
