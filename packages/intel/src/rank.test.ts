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

describe("non-hiring signals: eligibility and absent conditions", () => {
  const lenient = { ...pack, signals: { ...pack.signals, eligibility: { alone: ["explicit", "implicit", "pain"] as ("explicit" | "implicit" | "pain" | "trigger")[], triggers_needed: 2, corroborate: ["trigger"] as ("trigger" | "pain")[], fresh_days: 30, alone_min_strength: 1 } } };
  const scoreWith = (p: typeof pack, jobs: JobRow[], signals: SignalRow[] = []) => scoreAccount(buildEvidence(jobs, signals, p, roles, now), facts, p);
  it("one trigger alone is not enough; two independent fresh triggers are", () => {
    expect(score([], [sig("funding_raise", 5)]).eligible).toBe(false);
    expect(score([], [sig("funding_raise", 5), sig("cta_sales_led", 3)]).eligible).toBe(true);
    expect(score([], [sig("funding_raise", 5), sig("cta_sales_led", 3)]).intent).toBeGreaterThan(pack.signals.base_rate);
  });
  it("a tool signal (implicit) is eligible alone", () => {
    expect(score([], [sig("gtm_tool_added", 4)]).eligible).toBe(true);
  });
  it("pain counts alone only when the pack says so", () => {
    expect(score([], [sig("pain_post", 2)]).eligible).toBe(false);
    expect(scoreWith(lenient, [], [sig("pain_post", 2)]).eligible).toBe(true);
  });
  it("stale signals don't make an account eligible", () => {
    expect(score([], [sig("gtm_tool_added", 60)]).eligible).toBe(false);
  });
  it("absent: 'tool sprawl, no owner' fires only without an open core role", () => {
    expect(score([], [sig("stack_sprawl", 3)]).plays.map((p) => p.id)).toContain("stack_chaos");
    expect(score([job("RevOps Manager", 10)], [sig("stack_sprawl", 3)]).plays.map((p) => p.id)).not.toContain("stack_chaos");
  });
});

describe("reserved slots for non-hiring leads", () => {
  const mk = (name: string, sc: ReturnType<typeof score>) => ({ account: name, score: sc, incomplete: false, recentlyDelivered: false, newPlaySinceDelivery: false });
  const rows = () => [
    mk("hiring-1", score([job("RevOps Manager", 90)])),
    mk("hiring-2", score([job("GTM Engineer", 90)])),
    mk("funded+launched", score([], [sig("funding_raise", 5), sig("product_launch", 4)])),
    mk("hiring+tool", score([job("SDR", 5)], [sig("gtm_tool_added", 3)])),
  ];
  it("without a reservation, hiring wins the slots", () => {
    expect(rankAccounts(rows(), 2).leads.map((l) => l.account)).toEqual(["hiring-1", "hiring-2"]);
  });
  it("a reserved slot goes to a non-hiring-only company first", () => {
    const r = rankAccounts(rows(), 2, 5, { reserveNonHiring: 1, freshDays: 30 });
    expect(r.leads.map((l) => l.account).sort()).toEqual(["funded+launched", "hiring-1"]);
  });
  it("then to mixed companies with a fresh non-hiring signal; never more than the list", () => {
    const r = rankAccounts(rows(), 3, 5, { reserveNonHiring: 5, freshDays: 30 });
    expect(r.leads).toHaveLength(3);
    expect(r.leads.map((l) => l.account)).toContain("hiring+tool");
  });
});


describe("eligibility: alone_min_strength (weak signals need a second one)", () => {
  const strict = { ...pack, signals: { ...pack.signals, eligibility: { ...pack.signals.eligibility, alone: ["explicit", "implicit", "pain"] as ("explicit" | "implicit" | "pain" | "trigger")[], alone_min_strength: 4 } } };
  const s = (jobs: JobRow[], signals: SignalRow[] = []) => scoreAccount(buildEvidence(jobs, signals, strict, roles, now), facts, strict);
  it("a weak implicit signal (tool stack, strength 3) no longer qualifies alone", () => {
    expect(s([], [sig("stack_sprawl", 3)]).eligible).toBe(false);
    expect(s([], [sig("gtm_tool_added", 3)]).eligible).toBe(false);
  });
  it("two different weak signals, or one weak plus a trigger, qualify", () => {
    expect(s([], [sig("stack_sprawl", 3), sig("gtm_tool_added", 3)]).eligible).toBe(true);
    expect(s([], [sig("stack_sprawl", 3), sig("funding_raise", 5)]).eligible).toBe(true);
  });
  it("a strong signal (open core role, strength 4) still qualifies alone", () => {
    expect(s([job("RevOps Manager", 10)]).eligible).toBe(true);
  });
});

describe("ranking bias: tiny team matching two plays vs big company with many sales roles", () => {
  const small = { sizeBand: "2-10", region: "United States of America", segment: "b2b" };
  const big = { sizeBand: "51-150", region: "United States of America", segment: "b2b" };
  it("the small team's lead (founding GTM hire + fresh raise) outranks a large sales hiring spree", () => {
    const tiny = score([job("Founding Account Executive", 6)], [sig("funding_raise", 4)], small);
    const spree = score([
      job("Account Executive", 3), job("Account Executive, Enterprise", 5), job("Sales Development Representative", 2),
      job("SDR, EMEA", 7), job("Business Development Representative", 4), job("Sales Manager", 9),
    ], [], big);
    expect(tiny.plays.length).toBeGreaterThanOrEqual(2);
    console.log(`bias eval: tiny=${tiny.priority.toFixed(3)} (plays ${tiny.plays.length}) spree=${spree.priority.toFixed(3)} (plays ${spree.plays.length})`);
    expect(tiny.priority).toBeGreaterThan(spree.priority);
  });
  it("but a big company with an open core role (the role you substitute for) may still rank above it", () => {
    const withCore = score([job("RevOps Manager", 12), job("Account Executive", 3), job("SDR, EMEA", 7)], [], big);
    expect(withCore.eligible).toBe(true); // documented, not forced: an open core role is a real need at any size
  });
});

describe("plays: min_count, qualifies, and fit influence", () => {
  it("a qualifying play (3+ sales roles, no ops) makes an account eligible even under a strict floor", () => {
    const strict = { ...pack, signals: { ...pack.signals, eligibility: { ...pack.signals.eligibility, alone_min_strength: 5 } },
      plays: { plays: { ...pack.plays.plays, sales_without_ops: { title: "Sales without ops", requires: ["adjacent_role_open"], min_count: { adjacent_role_open: 3 }, absent: ["core_role_open", "core_role_open_45d"], window_days: 60, angle: "a", qualifies: true, personas: [] } } } };
    const s = (jobs: JobRow[]) => scoreAccount(buildEvidence(jobs, [], strict, roles, now), facts, strict);
    expect(s([job("Account Executive", 3), job("SDR", 4)]).eligible).toBe(false);
    const three = s([job("Account Executive", 3), job("SDR", 4), job("BDR", 5)]);
    expect(three.plays.map((p) => p.id)).toContain("sales_without_ops");
    expect(three.eligible).toBe(true);
  });
  it("influence 0 makes size irrelevant to priority", () => {
    const flat = { ...pack, icp: { ...pack.icp, soft_fit: { ...pack.icp.soft_fit, influence: 0 } } };
    const p = (sizeBand: string) => scoreAccount(buildEvidence([job("RevOps Manager", 10)], [], flat, roles, now), { ...facts, sizeBand }, flat).priority;
    expect(p("2-10")).toBe(p("51-150"));
  });
});

describe("known people as evidence", () => {
  it("one ops person = has an owner; two = ops team (only when the pack defines the types)", () => {
    const withTypes = { ...pack, signals: { ...pack.signals, signals: { ...pack.signals.signals,
      ops_owner_known: { class: "negative" as const, lr: 0.5, half_life_days: 365, strength: 3, fast_lane: false },
      ops_team_2plus: { class: "negative" as const, lr: 0.25, half_life_days: 365, strength: 3, fast_lane: false } } } };
    const p = (role: string, id: string) => ({ id, role, url: "https://x.test/p", fetchedAt: now });
    const types = (people: ReturnType<typeof p>[], pk: typeof pack = withTypes as typeof pack) => buildEvidence([], [], pk, roles, now, people).map((e) => e.type);
    expect(types([p("Founder", "1")])).toEqual([]);
    expect(types([p("Head of Revenue Operations", "1")])).toEqual(["ops_owner_known"]);
    expect(types([p("RevOps Manager", "1"), p("Marketing Operations Lead", "2")])).toEqual(["ops_team_2plus"]);
    expect(types([p("RevOps Manager", "1")], pack)).toEqual([]); // fixture pack doesn't define it: nothing emitted
  });
});
