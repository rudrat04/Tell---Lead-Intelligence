import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { parsePack } from "./load.js";
import { PACK_FILES } from "./schema.js";
import { FIXTURE_PACK_DIR } from "./fixture.js";

async function fixtureFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of PACK_FILES) { try { out[f] = await readFile(join(FIXTURE_PACK_DIR, `${f}.yaml`), "utf8"); } catch { /* optional */ } }
  return out;
}

describe("buyers.yaml: who to reach, apart from the ICP", () => {
  it("moves buyers.yaml into icp.personas, with department, seniority, years and decision power", async () => {
    const files = await fixtureFiles();
    const icp = parse(files.icp!) as Record<string, unknown>;
    const personas = icp.personas as { title: string }[];
    delete icp.personas;
    files.icp = stringify(icp);
    files.buyers = stringify({ buyers: personas.map((p, i) => ({ ...p, department: "Leadership", seniority: "founder", years: { min: 2, max: 30 }, decision_power: i === 0 ? 1 : 0.6 })) });
    const pack = parsePack(files);
    expect(pack.icp.personas.map((p) => p.title)).toEqual(personas.map((p) => p.title));
    expect(pack.icp.personas[0]!.decision_power).toBe(1);
    expect(pack.icp.personas[0]!.department).toBe("Leadership");
  });
  it("buyers in both files is an error; decision power defaults to 0.7", async () => {
    const files = await fixtureFiles();
    const personas = (parse(files.icp!) as { personas: unknown[] }).personas;
    expect(() => parsePack({ ...files, buyers: stringify({ buyers: personas }) })).toThrow(/set twice/);
    expect(parsePack(files).icp.personas[0]!.decision_power).toBe(0.7);
  });
  it("score weights must sum to 100", async () => {
    const files = await fixtureFiles();
    const sig = parse(files.signals!) as Record<string, unknown>;
    files.signals = stringify({ ...sig, score: { need: 60, fit: 20, timing: 15, buyer: 15 } });
    expect(() => parsePack(files)).toThrow(/sum to 100/);
  });
});
