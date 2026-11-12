import { describe, it, expect } from "vitest";
import { runWatcher, type Watcher } from "./types.js";

const item = { sourceId: "x", externalId: "1", url: "https://e.com/1", text: "t", meta: {} };

describe("runWatcher fallback", () => {
  it("uses fallback when primary throws", async () => {
    const w: Watcher = { id: "x", fetch: async () => { throw new Error("down"); }, fallback: async () => [item] };
    const r = await runWatcher(w, new Date());
    expect(r.usedFallback).toBe(true);
    expect(r.items).toHaveLength(1);
  });
  it("reports error when no fallback", async () => {
    const w: Watcher = { id: "x", fetch: async () => { throw new Error("down"); } };
    const r = await runWatcher(w, new Date());
    expect(r.error).toContain("down");
  });
});
