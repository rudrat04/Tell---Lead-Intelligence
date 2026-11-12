import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { runScheduledTick, TICK_WATCHERS } from "./scheduled.js";
import { istDay, type UsageStore } from "./usage.js";
import { isSourceEnabled } from "@tell/watchers";
import { costUsd } from "@tell/extract";

const configPath = fileURLToPath(new URL("../../../config/signals.yaml", import.meta.url));

describe("runScheduledTick", () => {
  it("skips without touching the store or LLM once the daily cap is spent", async () => {
    let added = 0;
    const usage: UsageStore = { spentToday: async () => 1.0, addSpend: async (_s, usd) => { added += usd; } };
    const store = { filterUnseen: async () => { throw new Error("should not run"); }, saveBatch: async () => {}, lastRunAt: async () => null };
    const r = await runScheduledTick({ configPath, dailyCapUsd: 1, usage, store });
    expect(r.skipped).toBe("daily Haiku cap reached");
    expect(added).toBe(0);
  });
  it("only enabled sources run (Reddit off by policy)", () => {
    expect(TICK_WATCHERS.filter((w) => isSourceEnabled(w.id)).map((w) => w.id)).toEqual(["hn"]);
  });
});

describe("cost + day helpers", () => {
  it("prices Haiku 5.5 usage including cache reads/writes", () => {
    // 1M in ($0.10) + 1M out ($0.50) + 1M cache write ($0.125) + 1M cache read ($0.01)
    expect(costUsd({ input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 })).toBeCloseTo(0.735, 6);
  });
  it("uses the IST calendar day", () => {
    // 20:00 UTC on Jan 1 is 01:30 IST on Jan 2
    expect(istDay(new Date(Date.UTC(2026, 0, 1, 20, 0)))).toBe("2026-01-02");
  });
});
