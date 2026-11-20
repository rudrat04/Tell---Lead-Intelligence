import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { validateBuiltPlay, buildPlay, type BuilderEvidence } from "./play-builder.js";

const pack = await loadFixturePack();
const persona = pack.icp.personas[0]!.title;
const ev: BuilderEvidence[] = [
  { type: "contract_won", quote: "Northwind Builders won a $2.0M contract from the Department of Examples.", ageDays: 5, current: false, strength: 4 },
  { type: "pricing_page_added", quote: "Northwind added a pricing page", ageDays: 10, current: false, strength: 3 },
];
const good = { qualifies: true, title: "Just won, next bids", need: "They just won a $2.0M federal contract.", angle: "Winners stop prospecting while they deliver.", offer: "A free list of similar open bids.", personas: [persona, "Not A Buyer"], citations: [0] };

describe("play builder checks (fictional)", () => {
  it("accepts a play backed by a strong cited signal; keeps only known buyers", () => {
    const r = validateBuiltPlay(JSON.stringify(good), ev, pack);
    expect(r.qualifies).toBe(true);
    if (r.qualifies) expect(r.play.personas).toEqual([persona]);
  });
  it("rejects one weak signal, invented numbers, missing citations, and passes on 'no need'", () => {
    expect(validateBuiltPlay(JSON.stringify({ ...good, citations: [1] }), ev, pack)).toMatchObject({ qualifies: false, reason: expect.stringMatching(/one weak signal/) });
    expect(validateBuiltPlay(JSON.stringify({ ...good, need: "They just won a $9.5M contract." }), ev, pack)).toMatchObject({ qualifies: false });
    expect(validateBuiltPlay(JSON.stringify({ ...good, citations: [7] }), ev, pack)).toMatchObject({ qualifies: false });
    expect(validateBuiltPlay(JSON.stringify({ qualifies: false, reason: "just a pricing page" }), ev, pack)).toEqual({ qualifies: false, reason: "just a pricing page" });
    expect(validateBuiltPlay("not json", ev, pack).qualifies).toBe(false);
  });
  it("two different weaker signals can carry a play together", async () => {
    const weak: BuilderEvidence[] = [{ ...ev[1]! }, { type: "content_motion", quote: "Northwind started a blog", ageDays: 3, current: false, strength: 3 }];
    const r = await buildPlay({ complete: async () => JSON.stringify({ ...good, need: "New pricing page and a new blog.", citations: [0, 1] }) }, pack, "Northwind", "", weak);
    expect(r.qualifies).toBe(true);
  });
});
