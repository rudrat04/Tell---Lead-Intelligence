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

describe("one-tap labels", () => {
  const D = "11111111-2222-4333-8444-555555555555";
  const kv = () => {
    const m = new Map<string, string>();
    return { m, put: async (k: string, v: string) => void m.set(k, v), get: async (k: string) => JSON.parse(m.get(k) ?? "null"),
      delete: async (k: string) => void m.delete(k),
      list: async ({ prefix }: { prefix: string }) => ({ keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }) };
  };
  const req = (path: string, init?: RequestInit) => new Request(`https://w.test${path}`, init);
  it("a GET only shows a confirm page; the POST stores the tap", async () => {
    const env = { LABEL_SECRET: "s3cret", LABELS: kv() };
    const sig = await (await import("./sign.js")).sign("s3cret", D, "good");
    const get = await worker.fetch(req(`/l?d=${D}&v=good&s=${sig}`), env);
    expect(get.status).toBe(200);
    expect(await get.text()).toContain("method=\"post\"");
    expect(env.LABELS.m.size).toBe(0);
    const post = await worker.fetch(req("/l", { method: "POST", body: new URLSearchParams({ d: D, v: "good", s: sig }) }), env);
    expect(post.status).toBe(200);
    expect(JSON.parse(env.LABELS.m.get(`tap:${D}`)!).v).toBe("good");
  });
  it("rejects a bad signature, a swapped label or a non-UUID id", async () => {
    const env = { LABEL_SECRET: "s3cret", LABELS: kv() };
    const { sign } = await import("./sign.js");
    const good = await sign("s3cret", D, "good");
    for (const q of [`d=${D}&v=good&s=${"0".repeat(32)}`, `d=${D}&v=bad&s=${good}`, `d=x&v=good&s=${good}`]) {
      expect((await worker.fetch(req(`/l?${q}`), env)).status).toBe(400);
    }
  });
  it("/taps needs the secret", async () => {
    const env = { LABEL_SECRET: "s3cret", LABELS: kv() };
    await env.LABELS.put(`tap:${D}`, JSON.stringify({ v: "bad", at: "2026-11-14T00:00:00Z" }));
    expect((await worker.fetch(req("/taps"), env)).status).toBe(403);
    const ok = await worker.fetch(req("/taps", { headers: { authorization: "Bearer s3cret" } }), env);
    expect(await ok.json()).toEqual([{ d: D, v: "bad", at: "2026-11-14T00:00:00Z" }]);
    const ack = await worker.fetch(req("/taps/ack", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify([D, "not-a-uuid"]) }), env);
    expect(await ack.json()).toEqual({ deleted: 1 });
    expect(env.LABELS.m.size).toBe(0);
  });
  it("find email: GET confirms only; POST queues the request and dispatches enrich.yml once a minute", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { calls.push(url); return new Response(null, { status: 204 }); });
    const env = { LABEL_SECRET: "s3cret", LABELS: kv(), GH_TOKEN: "t", GH_REPO: "o/r" };
    const { sign } = await import("./sign.js");
    const sig = await sign("s3cret", D, "enrich");
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) };
    const get = await worker.fetch(req(`/e?d=${D}&s=${sig}`), env, ctx);
    expect(await get.text()).toContain("Find email");
    expect(env.LABELS.m.size).toBe(0);
    expect((await worker.fetch(req(`/e?d=${D}&s=${await sign("s3cret", D, "good")}`), env, ctx)).status).toBe(400); // a label signature can't enrich
    await worker.fetch(req("/e", { method: "POST", body: new URLSearchParams({ d: D, s: sig }) }), env, ctx);
    await worker.fetch(req("/e", { method: "POST", body: new URLSearchParams({ d: D, s: sig }) }), env, ctx);
    await Promise.all(waits);
    expect(calls).toEqual(["https://api.github.com/repos/o/r/actions/workflows/enrich.yml/dispatches"]);
    expect(env.LABELS.m.has(`enrich:${D}`)).toBe(true);
    expect((await worker.fetch(req("/enrich-requests"), env, ctx)).status).toBe(403);
    const list = await (await worker.fetch(req("/enrich-requests", { headers: { authorization: "Bearer s3cret" } }), env, ctx)).json();
    expect(list.map((x: { d: string }) => x.d)).toEqual([D]);
    await worker.fetch(req("/enrich-requests/ack", { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify([D]) }), env, ctx);
    expect(env.LABELS.m.has(`enrich:${D}`)).toBe(false);
  });
});
