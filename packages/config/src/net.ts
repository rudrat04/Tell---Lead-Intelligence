import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Fetching pages we didn't choose (news articles, company sites, careers pages, robots.txt): only public hosts.
 * A URL, or any redirect it follows, that points at a private, loopback, link-local or cloud-metadata address is
 * refused, so a hostile page can't make a run read a service on the machine it runs on (your laptop on --show runs,
 * the Actions runner). Every hop is checked: redirects are followed by hand (at most MAX_REDIRECTS).
 */

const MAX_REDIRECTS = 5;

/** Is this IP address one no public page should point at? (pure; exported for tests) */
export function privateIp(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return privateIp(mapped[1]!);
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (isIP(v) === 6) return v === "::" || v === "::1" || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  return false;
}

/** Throws unless the URL is http(s) on a host that resolves only to public addresses. */
export async function assertPublicUrl(url: string | URL, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("not an http(s) URL");
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) throw new Error("not a public host");
  const ips = isIP(host) ? [host] : await resolve(host);
  if (!ips.length || ips.some(privateIp)) throw new Error("not a public host");
  return u;
}

/** fetch() for pages we didn't choose: every hop must be a public host (see above). Same Response as fetch. */
export async function publicFetch(url: string | URL, init: RequestInit = {}, deps: { fetcher?: typeof fetch; resolve?: (host: string) => Promise<string[]> } = {}): Promise<Response> {
  const f = deps.fetcher ?? fetch;
  let u = await assertPublicUrl(url, deps.resolve);
  for (let hop = 0; ; hop++) {
    const res = await f(u, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) {
      // (a hand-followed chain loses the final URL on the Response: callers read it from `url`)
      if (hop > 0) Object.defineProperty(res, "url", { value: u.toString() });
      return res;
    }
    if (hop >= MAX_REDIRECTS) throw new Error("too many redirects");
    u = await assertPublicUrl(new URL(loc, u), deps.resolve);
  }
}
