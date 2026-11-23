/**
 * Golden-set evals (plan section 13), run in CI. Fixtures are synthetic (public repo: no real companies or people).
 * Each "note" names the false-positive class it guards against; add a line whenever a new class is found.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFixturePack } from "@tell/config";
import { validateAnalysis, validateJudged, type AnalystInput } from "@tell/extract";
import { listReady, gateEvent } from "@tell/pipeline";
import { validateEventCheck } from "@tell/extract";
import { matchEvent, entityKey, type OppEvent } from "@tell/intel";
import { classifyJob, compileRoles, compileGigRules, gigVerdict, gate1, gate1Rules, looksLikeStaffing, critic, buildEvidence, scoreAccount, type JobRow, type SignalRow, type Evidence } from "@tell/intel";
import type { Pack } from "@tell/config";

const load = <T>(f: string): T[] =>
  readFileSync(fileURLToPath(new URL(`./golden/${f}`, import.meta.url)), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

const pack = await loadFixturePack();

function report(name: string, results: { ok: boolean; label: string }[]) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`eval ${name}: ${pass}/${results.length} (${Math.round((pass / results.length) * 100)}%)`);
  return results.filter((r) => !r.ok).map((r) => r.label);
}

describe("golden sets", () => {
  it("opportunity judge: ratings stand on cited evidence, offers come from the catalog, no invented numbers", () => {
    type Row = { note: string; evidence: string[]; reply: unknown; weak?: boolean; expect: { qualifies: boolean } & Partial<Record<"specific" | "urgent" | "prize" | "deliverable", number>> };
    // a synthetic catalog (the fixture pack has none): two free steps and two paid ones
    const caps = { capabilities: [
      { id: "list_recompetes", name: "Recompete watchlist", deliver: "contracts ending in the next 12 months", free: true, list: "recompetes" as const, good_for: "" },
      { id: "gtm_review", name: "Short GTM review", deliver: "a short written review of their setup", free: true, good_for: "" },
      { id: "teaming_outreach", name: "Teaming outreach", deliver: "outreach to primes", free: false, good_for: "" },
      { id: "gtm_system_build", name: "GTM system build", deliver: "CRM and routing set up", free: false, good_for: "" },
    ] };
    const judgePack = { ...pack, capabilities: caps };
    const rows = load<Row>("judge.jsonl");
    const failures = report("judge", rows.map((r) => {
      const ev = r.evidence.map((q, i) => ({ type: `t${i}`, quote: q, ageDays: 1, current: false, strength: r.weak ? 3 : 4 }));
      const out = validateJudged(JSON.stringify(r.reply), ev, judgePack, listReady);
      const scores = out.qualifies ? out.judged.rubric : out.rubric;
      const bad = [out.qualifies !== r.expect.qualifies && `qualifies ${out.qualifies}`,
        ...(["specific", "urgent", "prize", "deliverable"] as const).filter((k) => r.expect[k] != null && scores?.[k] !== r.expect[k]).map((k) => `${k} ${scores?.[k]} (want ${r.expect[k]})`)].filter(Boolean);
      return { ok: !bad.length, label: `${r.note}: ${bad.join(", ")}${out.qualifies ? "" : ` [${out.reason}]`}` };
    }));
    expect(failures).toEqual([]);
  });
  it("niche drafts: facts only, no overclaims, end on the offer question", () => {
    const rows = load<{ note: string; expect: "pass" | "reject"; evidence: string[]; subject: string; body: string }>("niche-drafts.jsonl");
    const failures = report("niche-drafts", rows.map((r) => {
      const input: AnalystInput = { company: "Northwind", domain: "northwind.example", facts: "", contactRole: "Founder", plays: [{ title: "x", angle: "y" }],
        evidence: r.evidence.map((q, i) => ({ type: "contract_won", ageDays: 1, current: false, quote: q, url: `https://ev.example/${i}` })) };
      const raw = JSON.stringify({ hypothesis: "They have a timely opportunity in the record.", angle: "Lead with the record.", opener: "saw the record about you.", citations: [0], counter_evidence: null, confidence: 0.6, email_subject: r.subject, email_body: r.body, linkedin_message: null });
      const a = validateAnalysis(raw, input, { maxWords: 90, noDurations: true });
      const passed = !!a?.email;
      return { ok: passed === (r.expect === "pass"), label: `${r.note}: ${passed ? "passed" : `rejected (${a?.emailProblems?.join("; ") ?? "invalid"})`}` };
    }));
    expect(failures).toEqual([]);
  });
  it("ranking archetypes: who should come first (needs over volume, states over old news)", () => {
    type Ev = { job?: string; signal?: string; days: number; closed?: number; seen?: number };
    type Side = { size?: string; ev: Ev[] };
    const now = new Date(Date.UTC(2026, 10, 12));
    const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const roles = compileRoles(pack.roles);
    let n = 0;
    const priority = (side: Side) => {
      const jobs: JobRow[] = side.ev.filter((e) => e.job).map((e) => ({ id: `j${++n}`, title: e.job!, url: `https://jobs.example/${n}`, employmentType: null, family: "x",
        postedAt: ago(e.days), firstSeenAt: ago(e.days), closedAt: e.closed == null ? null : ago(e.closed) }));
      const sigs: SignalRow[] = side.ev.filter((e) => e.signal).map((e) => ({ id: `s${++n}`, type: e.signal!, evidenceQuote: "q", evidenceUrl: `https://ev.example/${n}`,
        observedAt: ago(e.days), lastSeenAt: e.seen == null ? null : ago(e.seen) }));
      return scoreAccount(buildEvidence(jobs, sigs, pack, roles, now), { sizeBand: side.size ?? "11-50", region: "India", segment: "b2b" }, pack).priority;
    };
    const rows = load<{ higher: Side; lower: Side; note: string }>("ranking.jsonl");
    const failures = report("ranking", rows.map((r) => {
      const [h, l] = [priority(r.higher), priority(r.lower)];
      return { ok: h > l, label: `${r.note}: ${h.toFixed(4)} vs ${l.toFixed(4)}` };
    }));
    expect(failures).toEqual([]);
  });

  it("industry scope: each industry gets only its own signals and plays (no GTM offer to a drug maker, no permit offer to SaaS)", () => {
    // synthetic wiring (the fixture pack has no industries): GTM plays scoped to software, one niche play per niche industry
    const sig = (strength: number) => ({ class: "implicit" as const, lr: 5, half_life_days: 60, strength, fast_lane: false });
    const ind = (label: string, signals: string[]) => ({ label, aliases: [], description: `${label} companies`, buyers: [], list: "manual" as const, excluded: false, signals });
    const niche = (title: string, type: string, seg: string) => ({ title, requires: [type], requires_any: [], absent: [], window_days: 120, angle: "a", min_count: {}, qualifies: true, personas: [], industries: [seg] });
    const gtmTypes = Object.keys(pack.signals.signals);
    const scoped: Pack = { ...pack,
      signals: { ...pack.signals, signals: { ...pack.signals.signals, shortage_anda_dormant: sig(5), building_permit: sig(4) } },
      icp: { ...pack.icp, industries: { software: ind("Software", gtmTypes), pharma: ind("Pharma", ["shortage_anda_dormant", "core_role_filled"]), construction: ind("Construction", ["building_permit"]) } },
      plays: { ...pack.plays, plays: { ...Object.fromEntries(Object.entries(pack.plays.plays).map(([id, p]) => [id, { ...p, industries: ["software"] }])),
        shortage_relaunch: niche("Shortage drug", "shortage_anda_dormant", "pharma"), big_permit: niche("Big permit", "building_permit", "construction") } },
    };
    const rows = load<{ segment: string | null; signals: string[]; plays: string[]; note: string }>("industry-scope.jsonl");
    const failures = report("industry scope", rows.map((r) => {
      const ev: Evidence[] = r.signals.map((type, i) => ({ type, class: scoped.signals.signals[type]?.class ?? "implicit", ageDays: 2, current: false, quote: type, url: `https://ev.example/${i}`, ref: { kind: "signal" as const, id: `${i}` } }));
      const got = scoreAccount(ev, { sizeBand: "11-50", region: "India", segment: r.segment }, scoped).plays.map((p) => p.id).sort();
      return { ok: JSON.stringify(got) === JSON.stringify([...r.plays].sort()), label: `${r.note}: got [${got.join(", ")}]` };
    }));
    expect(failures).toEqual([]);
  });

  it("opportunity matching: the incumbent, ineligible set-asides and other industries never match", () => {
    const rows = load<{ event: { recipient: string; uei: string; naics: string; setAside: string | null }; member: { name: string; ueis: string[]; naics: Record<string, number>; setAsides: string[] }; expect: boolean; note: string }>("opportunity-match.jsonl");
    const failures = report("opportunity match", rows.map((r) => {
      const e: OppEvent = { key: "k", entityName: r.event.recipient, entityKey: entityKey(r.event.recipient), uei: r.event.uei, amount: 5e6, endDate: new Date("2027-08-01T00:00:00Z"),
        naics: r.event.naics, agency: "Department of Energy", subAgency: "", setAside: r.event.setAside, description: "support", state: null, url: "https://ev.example/1" };
      const m = { key: entityKey(r.member.name), name: r.member.name, facts: { naics: r.member.naics, agencies: {}, subAgencies: {}, setAsides: r.member.setAsides, awards: 3, total: 5e6, largest: 2e6, lastAwardAt: null, ueis: r.member.ueis, states: [], evidence: [] } };
      const got = matchEvent(e, m) != null;
      return { ok: got === r.expect, label: `${r.note}: got ${got}` };
    }));
    expect(failures).toEqual([]);
  });

  it("event fact-check: every lead's event is quoted, far enough along, where the prospect works, from a non-peer, in its trade", () => {
    type Row = { headline: string; article: string; reply: unknown; group: { segment: string; must?: string; keywords: string[] }; op: { beneficiary_regions?: string[]; min_stage?: "early" | "committed" | "buying" };
      region: string; fallback?: string; rosterId?: string; groups?: string[]; expect: string; note: string };
    const industries = ["pharma", "manufacturing", "construction", "staffing", "logistics", "medtech", "healthcare", "food"].map((id) => ({ id, label: id }));
    const failures = report("event gate", load<Row>("event-gate.jsonl").map((r) => {
      const c = validateEventCheck(JSON.stringify(r.reply), { headline: r.headline, article: r.article, industries, groups: (r.groups ?? []).map((id) => ({ id, label: id })) });
      const op = { kind: "news", beneficiary_regions: r.op.beneficiary_regions ?? [], keywords: r.group.keywords, min_stage: r.op.min_stage, verify: true } as unknown as Parameters<typeof gateEvent>[1];
      const roster = { kind: "company_search", segment: r.group.segment, must: r.group.must } as unknown as Parameters<typeof gateEvent>[2];
      const g = gateEvent(c, op, roster, r.region, "committed", r.fallback ?? null, r.rosterId);
      const got = g.ok ? "ok" : g.why;
      return { ok: got === r.expect, label: `${r.note}: expected ${r.expect}, got ${got}` };
    }));
    expect(failures).toEqual([]);
  });

  it("code critic: vendors, already-solved, out-of-ICP and unknown-size enterprise accounts are dropped", () => {
    type Row = { name: string; domain: string; title: string; tools: string[]; sizeBand?: string | null; segment?: string | null; evidence: { type: string; class: string; ageDays: number; current: boolean; url?: string }[]; expect: boolean; note?: string };
    const rows = load<Row>("critic.jsonl");
    const failures = report("critic", rows.map((r) => {
      const v = critic({ name: r.name, domain: r.domain, siteTitle: r.title, tools: r.tools, sizeBand: r.sizeBand ?? null, segment: r.segment ?? null,
        evidence: r.evidence.map((e, i) => ({ ...e, quote: e.type, url: e.url ?? "https://example.invalid", ref: { kind: "signal" as const, id: `${i}` } })) }, pack);
      return { ok: v.pass === r.expect, label: `${r.name} -> expected pass=${r.expect}, got ${v.failed.map((f) => f.check).join(",") || "pass"}${r.note ? ` (${r.note})` : ""}` };
    }));
    expect(failures).toEqual([]);
  });

  it("job titles -> role family (incl. every false-positive class found so far)", () => {
    const roles = compileRoles(pack.roles);
    const rows = load<{ title: string; type: string | null; expect: "core" | "adjacent" | null; note?: string }>("roles.jsonl");
    const failures = report("roles", rows.map((r) => ({ ok: (classifyJob(r.title, r.type ?? undefined, roles)?.family ?? null) === r.expect, label: `${r.title} -> expected ${r.expect}${r.note ? ` (${r.note})` : ""}` })));
    expect(failures).toEqual([]);
  });

  it("gig rules", () => {
    const rules = compileGigRules(pack.gigs);
    const rows = load<{ title: string; type: string; location: string; tags: string[]; expect: boolean; note?: string }>("gigs.jsonl");
    const failures = report("gigs", rows.map((r) => {
      const v = gigVerdict({ source: "eval", externalId: r.title, title: r.title, url: "https://example.invalid", employmentType: r.type, location: r.location, tags: r.tags, postedAt: new Date() }, rules);
      return { ok: v.ok === r.expect, label: `${r.title} [${r.type}, ${r.location}] -> expected ${r.expect}, got ${v.reason}${r.note ? ` (${r.note})` : ""}` };
    }));
    expect(failures).toEqual([]);
  });

  it("Gate 1 (free keyword gate): recall on real needs, rejects known noise", () => {
    const g = gate1Rules(pack);
    const rows = load<{ text: string; expect: boolean; note?: string }>("gate1.jsonl");
    const results = rows.map((r) => ({ ok: gate1(r.text, g.never, g.required).pass === r.expect, label: `"${r.text.slice(0, 60)}" -> expected ${r.expect}${r.note ? ` (${r.note})` : ""}` }));
    const failures = report("gate1", results);
    // plan 13 target: Gate 1 recall > 95% on genuine needs
    const positives = rows.filter((r) => r.expect);
    const recall = positives.filter((r) => gate1(r.text, g.never, g.required).pass).length / positives.length;
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(failures).toEqual([]);
  });

  it("staffing agencies (their boards list clients' roles, not their own)", () => {
    const rows = load<{ name: string; texts: string[]; titles?: string[]; expect: boolean; note?: string }>("staffing.jsonl");
    const failures = report("staffing", rows.map((r) => ({ ok: looksLikeStaffing(r.name, r.texts, r.titles ?? []) === r.expect, label: `${r.name} -> expected ${r.expect}${r.note ? ` (${r.note})` : ""}` })));
    expect(failures).toEqual([]);
  });
});
