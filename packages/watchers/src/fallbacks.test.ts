import { describe, it, expect, vi, afterEach } from "vitest";
import { serperSearch, hitsToItems, type SearchHit } from "./web-search.js";
import { serperNews, newsDate, companiesFromNews } from "./funding-news.js";
import { serperOrganic, titleName, brandfetchBrand, parseBrand } from "./resolvers.js";
import { exaRequest } from "./people-search.js";
import { tavilyToSearchHits, tavilyToNews, tavilyToCompanyHits, tavilySearch, tavilyCountry, newsQueryFor } from "./tavily.js";
import { parseInboxTrue, parseQev, inboxTrueVerify, parseApollo, apolloFind } from "./mail-apis.js";

/**
 * Fallbacks must not change the output: when the primary answers, the fallback is never called and the result is what
 * it was; when the fallback answers, it comes out in the primary's shape and the same downstream code reads it the same.
 */

const NOW = new Date("2026-11-22T06:00:00Z");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; init?: RequestInit };
function stubFetch(answer: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => { calls.push({ url: String(url), init }); return answer(String(url), init); }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const SERPER_ORGANIC = { organic: [{ title: "Need help with our CRM migration - Contoso", link: "https://www.linkedin.com/posts/jane-doe_crm-activity-1", snippet: "Looking for someone to clean up our HubSpot.", date: "2 days ago" }] };
const TAVILY_SAME = { results: [{ title: "Need help with our CRM migration - Contoso", url: "https://www.linkedin.com/posts/jane-doe_crm-activity-1", content: "Looking for someone to clean up our HubSpot.", published_date: "Fri, 20 Nov 2026 06:00:00 GMT" }] };

describe("Serper -> Tavily: web search", () => {
  it("Serper answers: Tavily is never called and the hits are Serper's", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const calls = stubFetch(() => json(SERPER_ORGANIC));
    const hits = await serperSearch({ apiKey: "k", timeRange: "w", country: "in" })("crm help");
    expect(hits).toEqual(SERPER_ORGANIC.organic);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["google.serper.dev"]);
  });
  it("Serper out of credits: the same search on Tavily, in Serper's shape, read the same downstream", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const calls = stubFetch((u) => (u.includes("serper") ? json({ message: "Not enough credits" }, 400) : json(TAVILY_SAME)));
    const hits = await serperSearch({ apiKey: "k", timeRange: "w", country: "in" })("crm help");
    expect(calls.map((c) => new URL(c.url).host)).toEqual(["google.serper.dev", "api.tavily.com"]);
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent).toMatchObject({ query: "crm help", topic: "general", time_range: "w", country: "india", search_depth: "basic" });
    // downstream: the raw item the gates see is the same as from Serper's hit, apart from the date's format
    const fromSerper = hitsToItems(SERPER_ORGANIC.organic, "crm help", NOW, 30)[0]!;
    const fromTavily = hitsToItems(hits, "crm help", NOW, 30)[0]!;
    expect({ ...fromTavily, postedAt: undefined }).toEqual({ ...fromSerper, postedAt: undefined });
    expect(fromTavily.postedAt?.toISOString().slice(0, 10)).toBe("2026-11-20");
  });
  it("no Tavily key: Serper's error stands, exactly as before", async () => {
    stubFetch(() => json({}, 400));
    await expect(serperSearch({ apiKey: "k", timeRange: "w", country: "in" })("q")).rejects.toThrow("serper -> 400");
  });
  it("Tavily failing too: Serper's error stands", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    stubFetch((u) => json({}, u.includes("serper") ? 429 : 432));
    await expect(serperSearch({ apiKey: "k", timeRange: "w", country: "us" })("q")).rejects.toThrow("serper -> 429");
  });
  it("snippets are cut to Google's length at a word; untitled results dropped", () => {
    const long = "word ".repeat(200);
    const [h] = tavilyToSearchHits([{ title: "T", url: "https://a.com/x", content: long }, { url: "https://b.com" }]);
    expect(h!.snippet.length).toBeLessThanOrEqual(303);
    expect(h!.snippet.endsWith("...")).toBe(true);
    expect(tavilyToSearchHits([{ url: "https://b.com" }])).toEqual([]);
    expect(tavilyCountry("IN")).toBe("india");
    expect(tavilyCountry("zz")).toBeUndefined();
    expect(newsQueryFor("pharma plant approval india", "india")).toBe("pharma plant approval india");
    expect(newsQueryFor("raises", "united states")).toBe("raises United States");
  });
});

describe("Serper -> Tavily: news", () => {
  const serperNewsBody = { news: [{ title: "Northwind Labs raises $12M Series A", link: "https://news.example.com/northwind", date: "2 days ago", source: "Example News" }] };
  it("Serper answers: unchanged, Tavily not called", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const calls = stubFetch(() => json(serperNewsBody));
    const items = await serperNews({ apiKey: "k", country: "in", timeRange: "w", now: () => NOW })("raises series a");
    expect(items).toEqual([{ title: "Northwind Labs raises $12M Series A", url: "https://news.example.com/northwind", postedAt: newsDate("2 days ago", NOW), outlet: "Example News" }]);
    expect(calls).toHaveLength(1);
  });
  it("Serper refused: Tavily news gives the same headline, link and day; the company read from it is the same", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const calls = stubFetch((u) => (u.includes("serper") ? json({}, 403) : json({ results: [{ title: "Northwind Labs raises $12M Series A", url: "https://news.example.com/northwind", content: "...", published_date: "Fri, 20 Nov 2026 06:00:00 GMT" }] })));
    const items = await serperNews({ apiKey: "k", country: "in", timeRange: "w", now: () => NOW })("raises series a");
    const sent = JSON.parse(String(calls[1]!.init!.body));
    expect(sent.topic).toBe("news");
    expect(sent.country).toBeUndefined(); // Tavily takes a country for general search only...
    expect(sent.query).toBe("raises series a India"); // ...so the country goes in the query
    expect(items[0]).toMatchObject({ title: "Northwind Labs raises $12M Series A", url: "https://news.example.com/northwind", outlet: "news.example.com" });
    expect(items[0]!.postedAt?.toISOString().slice(0, 10)).toBe("2026-11-20");
    const viaSerper = companiesFromNews([{ title: "Northwind Labs raises $12M Series A", url: "https://news.example.com/northwind", postedAt: newsDate("2 days ago", NOW), outlet: "Example News" }]);
    expect(companiesFromNews(items).map((c) => c.name)).toEqual(viaSerper.map((c) => c.name));
  });
  it("a future or unreadable date is no date (as newsDate does for Serper)", () => {
    expect(tavilyToNews([{ title: "a", url: "https://x.com/a", published_date: "Sun, 20 Dec 2026 00:00:00 GMT" }], NOW)[0]!.postedAt).toBeNull();
    expect(tavilyToNews([{ title: "a", url: "https://x.com/a", published_date: "soon" }], NOW)[0]!.postedAt).toBeNull();
  });
});

describe("Serper -> Tavily: company candidates", () => {
  it("same candidates as Serper's organic results for the same pages", async () => {
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const page = { title: "Contoso Pharma | Generic APIs", url: "https://contosopharma.com/", content: "API maker." };
    stubFetch(() => json({ organic: [{ title: page.title, link: page.url, snippet: page.content }] }));
    const viaSerper = await serperOrganic("k", "contoso pharma", "in");
    stubFetch((u) => (u.includes("serper") ? json({}, 400) : json({ results: [page] })));
    const viaTavily = await serperOrganic("k", "contoso pharma", "in");
    expect(viaTavily).toEqual(viaSerper);
    expect(tavilyToCompanyHits([page], titleName)[0]!.name).toBe("Contoso Pharma");
  });
  it("tavilySearch: no key = null, never a request", async () => {
    const calls = stubFetch(() => json({ results: [] }));
    expect(await tavilySearch({ query: "q" }, "")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("Exa second key", () => {
  const body = { query: "acme.com", category: "company", type: "auto", numResults: 3 };
  it("first key answers: one request, never the second key", async () => {
    const f = vi.fn(async () => json({ results: [] }));
    const res = await exaRequest(body, "key1", f as unknown as typeof fetch, "key2");
    expect(res.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("first key refused (credits spent): the identical request once on the second key", async () => {
    const keys: string[] = [], bodies: string[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => { const k = (init.headers as Record<string, string>)["x-api-key"]!; keys.push(k); bodies.push(String(init.body)); return k === "key1" ? json({ error: "credits" }, 402) : json({ results: [{ url: "https://acme.com" }] }); });
    const res = await exaRequest(body, "key1", f as unknown as typeof fetch, "key2");
    expect(keys).toEqual(["key1", "key2"]);
    expect(bodies[0]).toBe(bodies[1]);
    expect(res.status).toBe(200);
  });
  it("a spent first key is skipped for the rest of the run; a rate limit isn't remembered", async () => {
    const keys: string[] = [];
    const f = vi.fn(async (_u: string, init: RequestInit) => { const k = (init.headers as Record<string, string>)["x-api-key"]!; keys.push(k); return k === "spent1" ? json({}, 402) : k === "busy1" ? json({}, 429) : json({ results: [] }); });
    await exaRequest(body, "spent1", f as unknown as typeof fetch, "key2");
    await exaRequest(body, "spent1", f as unknown as typeof fetch, "key2");
    await exaRequest(body, "busy1", f as unknown as typeof fetch, "key2");
    await exaRequest(body, "busy1", f as unknown as typeof fetch, "key2");
    expect(keys).toEqual(["spent1", "key2", "key2", "busy1", "key2", "busy1", "key2"]);
  });
  it("a server error is not a refused key: no retry; no second key: the refusal stands", async () => {
    const f = vi.fn(async () => json({}, 500));
    expect((await exaRequest(body, "key1", f as unknown as typeof fetch, "key2")).status).toBe(500);
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn(async () => json({}, 402));
    expect((await exaRequest(body, "key1", g as unknown as typeof fetch, undefined)).status).toBe(402);
    expect((await exaRequest(body, "key1", g as unknown as typeof fetch, "key1")).status).toBe(402);
    expect(g).toHaveBeenCalledTimes(2);
  });
});

describe("InboxTrue gives QuickEmailVerification's verdicts", () => {
  it("each verdict maps to the one QEV would give for the same address", () => {
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ validity: "valid", is_domain_catchall: false, is_disposable: false }, { success: "true", result: "valid", accept_all: "false", disposable: "false" }],
      [{ validity: "invalid", is_domain_catchall: false, is_disposable: false }, { success: "true", result: "invalid", accept_all: "false", disposable: "false" }],
      [{ validity: "valid", is_domain_catchall: true, is_disposable: false }, { success: "true", result: "valid", accept_all: "true", disposable: "false" }],
      [{ validity: "ambiguous", is_domain_catchall: null, is_disposable: false }, { success: "true", result: "unknown", accept_all: "false", disposable: "false" }],
      [{ validity: "valid", is_domain_catchall: false, is_disposable: true }, { success: "true", result: "valid", accept_all: "false", disposable: "true" }],
    ];
    for (const [it, qev] of pairs) expect(parseInboxTrue(it)).toEqual(parseQev(qev));
    for (const v of ["maybe_valid", "greylisted", "temp_error", "perm_error"]) expect(parseInboxTrue({ validity: v })!.result).toBe("unknown");
    expect(parseInboxTrue({ validity: "malformed" })!.result).toBe("invalid");
    expect(parseInboxTrue({})).toBeNull();
  });
  it("a request: bearer key, the address as a query parameter; no key = no request", async () => {
    let seen: Call | null = null;
    const f = vi.fn(async (url: string, init?: RequestInit) => { seen = { url, init }; return json({ validity: "valid", is_domain_catchall: false, is_disposable: false }); });
    expect(await inboxTrueVerify("jane@contoso.com", "it-key", f as unknown as typeof fetch)).toEqual({ result: "valid", acceptAll: false, disposable: false });
    expect(new URL(seen!.url).searchParams.get("email")).toBe("jane@contoso.com");
    expect((seen!.init!.headers as Record<string, string>).authorization).toBe("Bearer it-key");
    expect(await inboxTrueVerify("jane@contoso.com", "", f as unknown as typeof fetch)).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("Apollo finder answers like the other finders", () => {
  it("an address at the company's own domain; verified only when Apollo says so", () => {
    expect(parseApollo({ person: { email: "Jane.Doe@Contoso.com", email_status: "verified" } }, "contoso.com")).toEqual({ address: "jane.doe@contoso.com", score: null, verified: true });
    expect(parseApollo({ person: { email: "jane@eu.contoso.com", email_status: "guessed" } }, "contoso.com")).toEqual({ address: "jane@eu.contoso.com", score: null, verified: false });
  });
  it("locked placeholders, other domains and no match are no answer", () => {
    expect(parseApollo({ person: { email: "email_not_unlocked@domain.com", email_status: "unavailable" } }, "contoso.com")).toBeNull();
    expect(parseApollo({ person: { email: "jane@gmail.com", email_status: "verified" } }, "contoso.com")).toBeNull();
    expect(parseApollo({ person: { email: "jane@notcontoso.com" } }, "contoso.com")).toBeNull();
    expect(parseApollo({ person: null }, "contoso.com")).toBeNull();
  });
  it("no key = no request", async () => {
    const f = vi.fn(async () => json({}));
    expect(await apolloFind("Jane", "Doe", "contoso.com", "", f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("Brandfetch Brand API (cached brands only)", () => {
  it("asks for cached brands only; a 204 costs nothing, a 200 and a 404 cost one fetch", async () => {
    const urls: string[] = [];
    const answer = (status: number, body?: unknown) => vi.fn(async (u: string) => { urls.push(u); return status === 204 ? new Response(null, { status }) : json(body ?? {}, status); }) as unknown as typeof fetch;
    expect(await brandfetchBrand("contoso.in", "bf", answer(204))).toEqual({ facts: null, charged: false });
    expect(urls[0]).toContain("cachedOnly=true");
    expect(await brandfetchBrand("contoso.in", "bf", answer(404))).toEqual({ facts: null, charged: true });
    expect(await brandfetchBrand("contoso.in", "bf", answer(200, { domain: "contoso.in", name: "Contoso", company: { location: { country: "India" } } })))
      .toEqual({ facts: { domain: "contoso.in", name: "Contoso", country: "India" }, charged: true });
    expect(await brandfetchBrand("contoso.in", "", answer(200))).toEqual({ facts: null, charged: false });
    expect(parseBrand({ name: "x" })).toBeNull();
  });
});
