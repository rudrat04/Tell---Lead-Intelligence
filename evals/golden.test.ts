/**
 * Golden-set evals (plan section 13), run in CI. Fixtures are synthetic (public repo: no real companies or people).
 * Each "note" names the false-positive class it guards against; add a line whenever a new class is found.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadFixturePack } from "@tell/config";
import { classifyJob, compileRoles, compileGigRules, gigVerdict, gate1, gate1Rules, looksLikeStaffing, critic } from "@tell/intel";

const load = <T>(f: string): T[] =>
  readFileSync(fileURLToPath(new URL(`./golden/${f}`, import.meta.url)), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);

const pack = await loadFixturePack();

function report(name: string, results: { ok: boolean; label: string }[]) {
  const pass = results.filter((r) => r.ok).length;
  console.log(`eval ${name}: ${pass}/${results.length} (${Math.round((pass / results.length) * 100)}%)`);
  return results.filter((r) => !r.ok).map((r) => r.label);
}

describe("golden sets", () => {
  it("code critic: vendors and already-solved accounts are dropped", () => {
    type Row = { name: string; domain: string; title: string; tools: string[]; evidence: { type: string; class: string; ageDays: number; current: boolean }[]; expect: boolean; note?: string };
    const rows = load<Row>("critic.jsonl");
    const failures = report("critic", rows.map((r) => {
      const v = critic({ name: r.name, domain: r.domain, siteTitle: r.title, tools: r.tools, evidence: r.evidence.map((e, i) => ({ ...e, quote: e.type, url: "https://example.invalid", ref: { kind: "signal" as const, id: `${i}` } })) }, pack);
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
    const rows = load<{ name: string; texts: string[]; expect: boolean; note?: string }>("staffing.jsonl");
    const failures = report("staffing", rows.map((r) => ({ ok: looksLikeStaffing(r.name, r.texts) === r.expect, label: `${r.name} -> expected ${r.expect}${r.note ? ` (${r.note})` : ""}` })));
    expect(failures).toEqual([]);
  });
});
