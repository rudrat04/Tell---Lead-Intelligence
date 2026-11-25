import { describe, it, expect } from "vitest";
import { privateIp, assertPublicUrl, publicFetch } from "./net.js";

const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
describe("fetching only public hosts", () => {
  it("knows private, loopback, link-local, metadata and mapped addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.20.1.1", "192.168.1.5", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(privateIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(privateIp(ip)).toBe(false);
  });
  it("refuses localhost, private names, private DNS answers and non-http URLs", async () => {
    await expect(assertPublicUrl("http://localhost:3000/x")).rejects.toThrow();
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://printer.local/")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("https://evil.example/", dns({ "evil.example": ["10.1.2.3"] }))).rejects.toThrow();
    await expect(assertPublicUrl("https://news.example/a", dns({ "news.example": ["93.184.216.34"] }))).resolves.toBeInstanceOf(URL);
  });
  it("checks every redirect: a public page that redirects to the metadata address is refused", async () => {
    const resolve = dns({ "news.example": ["93.184.216.34"], "cdn.example": ["93.184.216.35"] });
    const hop = (to: string | null, body = "ok") => new Response(to ? null : body, { status: to ? 302 : 200, headers: to ? { location: to } : {} });
    const chain: Record<string, Response> = { "https://news.example/a": hop("https://cdn.example/b"), "https://cdn.example/b": hop(null, "page") };
    const fetcher = (async (u: URL) => chain[u.toString()]!) as unknown as typeof fetch;
    const r = await publicFetch("https://news.example/a", {}, { fetcher, resolve });
    expect(await r.text()).toBe("page");
    expect(r.url).toBe("https://cdn.example/b");
    const bad = (async () => hop("http://169.254.169.254/latest/meta-data")) as unknown as typeof fetch;
    await expect(publicFetch("https://news.example/a", {}, { fetcher: bad, resolve })).rejects.toThrow();
  });
});
