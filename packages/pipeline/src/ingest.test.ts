import { describe, it, expect } from "vitest";
import { runTick, type Store } from "./ingest.js";
import type { Watcher, RawItem } from "@tell/watchers";
import type { LlmClient } from "@tell/extract";

const item = (id: string, text: string): RawItem => ({ sourceId: "s", externalId: id, url: "https://e.com/" + id, text, meta: {} });
const g3 = { author_role: "founder", ask_type: "hire", problem_category: "crm", company_identifiable: false, company_name: null, urgency_or_budget_hint: true, self_promotion: false, strength: 5, evidence_quote: "freelancer to set up HubSpot" };

function memStore() {
  const seen = new Set<string>();
  const saved: Parameters<Store["saveBatch"]>[0][] = [];
  let last: Date | null = null;
  const store: Store = {
    filterUnseen: async (hs) => new Set(hs.filter((h) => !seen.has(h))),
    saveBatch: async (b) => {
      saved.push(b);
      b.items.forEach((i) => seen.add(i.hash));
      if (!b.error && !b.incomplete) last = new Date();
    },
    lastRunAt: async () => last,
  };
  return { store, saved, lastRun: () => last };
}

const llm: LlmClient = { complete: async ({ system }) => JSON.stringify(system.includes("skeptical") ? { genuine_need: true, disqualifier: "none", reason: "ok" } : g3) };
const gate1 = (t: string) => ({ pass: !t.includes("recruiting"), reason: "r", injectionFlag: false });

describe("runTick", () => {
  it("processes new items once; repeat tick skips seen content without LLM", async () => {
    const { store, saved } = memStore();
    const w: Watcher = { id: "s", fetch: async () => [item("1", "Need a freelancer to set up HubSpot please"), item("2", "We are a recruiting firm with candidates")] };
    const first = await runTick({ store, gates: { llm, gate1 }, watchers: [w] });
    expect(first[0]).toMatchObject({ fetched: 2, newItems: 2, confirmed: 1, rejected: 1 });
    const second = await runTick({ store, gates: { llm, gate1 }, watchers: [w] });
    expect(second[0]).toMatchObject({ fetched: 2, newItems: 0 });
    expect(saved).toHaveLength(2);
  });
  it("records watcher failure without throwing, and does not advance lastRunAt", async () => {
    const { store, lastRun } = memStore();
    const w: Watcher = { id: "s", fetch: async () => { throw new Error("down"); } };
    const r = await runTick({ store, gates: { llm, gate1 }, watchers: [w] });
    expect(r[0]!.error).toContain("down");
    expect(lastRun()).toBeNull();
  });
  it("items beyond the per-tick cap are not marked seen and get processed next tick", async () => {
    const { store, saved, lastRun } = memStore();
    const w: Watcher = { id: "s", fetch: async () => [1, 2, 3].map((n) => item(String(n), `Need a freelancer to set up HubSpot please #${n}`)) };
    const first = await runTick({ store, gates: { llm, gate1 }, watchers: [w], maxPerSource: 2 });
    expect(first[0]).toMatchObject({ newItems: 3, confirmed: 2 });
    expect(saved[0]!.incomplete).toBe(true);
    expect(lastRun()).toBeNull();
    const second = await runTick({ store, gates: { llm, gate1 }, watchers: [w], maxPerSource: 2 });
    expect(second[0]).toMatchObject({ newItems: 1, confirmed: 1 });
    expect(lastRun()).not.toBeNull();
  });
  it("stops cascading when the LLM throws (spend cap)", async () => {
    const { store } = memStore();
    const capped: LlmClient = { complete: async () => { throw new Error("cap"); } };
    const w: Watcher = { id: "s", fetch: async () => [item("1", "Need a freelancer to set up HubSpot please")] };
    const r = await runTick({ store, gates: { llm: capped, gate1 }, watchers: [w] });
    expect(r[0]!.error).toContain("cap");
    expect(r[0]!.confirmed).toBe(0);
  });
});
