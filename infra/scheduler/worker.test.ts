import { describe, it, expect, vi, afterEach } from "vitest";
// @ts-expect-error plain JS Worker module
import worker from "./worker.js";

afterEach(() => vi.unstubAllGlobals());

async function run(cron: string, status = 204) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); });
  const waits: Promise<unknown>[] = [];
  await worker.scheduled({ cron }, { GH_TOKEN: "t", GH_REPO: "o/r" }, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  return calls;
}

describe("scheduler worker", () => {
  it.each([["*/30 * * * *", "tick.yml"], ["0 2 * * *", "daily.yml"], ["15 22 * * 6", "boards.yml"]])("%s dispatches %s on main", async (cron, wf) => {
    const [c] = await run(cron);
    expect(c!.url).toBe(`https://api.github.com/repos/o/r/actions/workflows/${wf}/dispatches`);
    expect(JSON.parse(c!.init.body as string)).toEqual({ ref: "main" });
    expect((c!.init.headers as Record<string, string>).authorization).toBe("Bearer t");
  });
  it("fails loudly when GitHub refuses (visible in Cloudflare logs)", async () => {
    await expect(run("0 2 * * *", 403)).rejects.toThrow("HTTP 403");
  });
});
