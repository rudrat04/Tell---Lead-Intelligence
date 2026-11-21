import { describe, it, expect } from "vitest";
import { loadFixturePack } from "./fixture.js";
import { PackSchema, type Pack } from "./schema.js";
import { industryMap, packWarnings, nicheFeeds, capabilitiesFor, industryCounts, industriesIgnoring } from "./wiring.js";

const base = async () => structuredClone(await loadFixturePack()) as unknown as Record<string, any>;
const issues = (p: unknown) => { const r = PackSchema.safeParse(p); return r.success ? [] : r.error.issues.map((i) => i.message); };
const ind = (label: string, signals?: string[]) => ({ label, aliases: [], description: `${label} companies`, buyers: [], list: "manual", excluded: false, ...(signals ? { signals } : {}) });

describe("industry wiring checks (pack:check)", () => {
  it("a play scoped to an unknown industry", async () => {
    const p = await base();
    p.plays.plays.struggling_to_hire.industries = ["nowhere"];
    expect(issues(p).join()).toMatch(/unknown industry "nowhere"/);
  });
  it("a scoped play that needs a signal its industry doesn't count can never fire", async () => {
    const p = await base();
    p.icp.industries = { software: ind("Software", ["funding_raise"]) };
    p.plays.plays.struggling_to_hire.industries = ["software"];
    expect(issues(p).join()).toMatch(/can never fire for "software": it requires core_role_open_45d/);
  });
  it("an industry counting a signal type that doesn't exist", async () => {
    const p = await base();
    p.icp.industries = { software: ind("Software", ["no_such_type"]) };
    expect(issues(p).join()).toMatch(/unknown signal type "no_such_type"/);
  });
  it("a capability scoped to an unknown industry", async () => {
    const p = await base();
    p.capabilities = { capabilities: [{ id: "x", name: "X", deliver: "a useful thing", free: true, good_for: "", industries: ["nowhere"] }] };
    expect(issues(p).join()).toMatch(/unknown industry "nowhere"/);
  });
});

describe("industry map (pack:map)", () => {
  const pack = async (edit: (p: Record<string, any>) => void) => { const p = await base(); edit(p); return PackSchema.parse(p) as Pack; };
  it("shows the plays that can fire and flags the leaks", async () => {
    const p = await pack((p) => {
      p.icp.industries = { software: ind("Software", ["core_role_open_45d", "funding_raise"]), pharma: ind("Pharma") };
      p.plays.plays.struggling_to_hire.industries = ["software"];
    });
    const m = Object.fromEntries(industryMap(p).map((w) => [w.segment, w]));
    expect(m.software!.plays.find((x) => x.id === "struggling_to_hire")?.scoped).toBe(true);
    expect(m.pharma!.plays.some((x) => x.id === "struggling_to_hire")).toBe(false);
    expect(m.pharma!.warnings.join()).toMatch(/counts every signal type/);
    expect(m.pharma!.warnings.join()).toMatch(/unscoped plays can fire here/);
  });
  it("a niche source writing a signal its industry doesn't count is wasted lookups", async () => {
    const p = await pack((p) => {
      p.icp.industries = { pharma: ind("Pharma", ["anda_approved"]) };
      p.icp.hard_filters.industries_any = [...p.icp.hard_filters.industries_any, "Pharma"];
      p.icp.segment_map = { ...p.icp.segment_map, Pharma: "pharma" };
      p.signals.signals.anda_approved = { class: "implicit", lr: 3, half_life_days: 60, strength: 4, fast_lane: false };
      p.signals.signals.shortage_anda_dormant = { class: "implicit", lr: 3, half_life_days: 60, strength: 5, fast_lane: false };
      p.sources.niche.fda_shortage = { ...p.sources.niche.fda_shortage, enabled: true, segment: "pharma" };
    });
    expect(nicheFeeds(p).filter((f) => f.segment === "pharma").map((f) => f.type)).toEqual(["shortage_anda_dormant", "shortage_anda_marketed"]);
    expect(packWarnings(p).join("\n")).toMatch(/pharma: fda_shortage writes shortage_anda_dormant for it, which it doesn't count/);
    expect(packWarnings(p).join("\n")).toMatch(/pharma: no source writes anda_approved/);
  });
  it("a type you import yourself (sources.niche.imports) is fed, not a warning", async () => {
    const p = await pack((p) => {
      p.icp.industries = { pharma: ind("Pharma", ["anda_approved"]) };
      p.signals.signals.anda_approved = { class: "implicit", lr: 3, half_life_days: 60, strength: 4, fast_lane: false };
      p.sources.niche.imports = ["anda_approved"];
    });
    expect(industryMap(p)[0]!.imported).toEqual(["anda_approved"]);
    expect(packWarnings(p).join("\n")).not.toMatch(/no source writes/);
  });
  it("capabilities go only to their industries; unscoped ones go everywhere", async () => {
    const cap = (id: string, industries: string[]) => ({ id, name: id, deliver: "a useful thing", free: true, good_for: "", industries });
    const p = { capabilities: { capabilities: [cap("permits", ["construction"]), cap("review", [])] } } as Pick<Pack, "capabilities">;
    expect(capabilitiesFor(p, "construction").map((c) => c.id)).toEqual(["permits", "review"]);
    expect(capabilitiesFor(p, "pharma").map((c) => c.id)).toEqual(["review"]);
    expect(capabilitiesFor(p, null).map((c) => c.id)).toEqual(["review"]);
  });
});

describe("signals are specific to their industry", () => {
  const p = { icp: { industries: { software: { signals: ["funding_raise", "tool_overlap"] }, pharma: { signals: ["shortage_anda_dormant"] }, logistics: {} } } } as unknown as Pick<Pack, "icp">;
  it("a government or pharma signal never counts for a SaaS company", () => {
    expect(industryCounts(p, "software", "contract_won")).toBe(false);
    expect(industryCounts(p, "software", "shortage_anda_dormant")).toBe(false);
    expect(industryCounts(p, "software", "funding_raise")).toBe(true);
    expect(industryCounts(p, "pharma", "tool_overlap")).toBe(false);
  });
  it("unknown or unscoped industries count everything (until the industry is known)", () => {
    expect(industryCounts(p, null, "contract_won")).toBe(true);
    expect(industryCounts(p, "logistics", "contract_won")).toBe(true);
  });
  it("watchers skip industries that count none of what they write", () => {
    expect(industriesIgnoring(p, ["tool_overlap", "stack_sprawl"])).toEqual(["pharma"]);
  });
});
