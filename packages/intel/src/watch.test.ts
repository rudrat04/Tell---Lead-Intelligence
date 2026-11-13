import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { extractSiteFacts } from "@tell/watchers";
import { compileTools, toolsFromTxt, diffSite, diffDnsTools, stackSprawl, isFundingHeadline, eventsFromYcProfile } from "./watch.js";

const rules = compileTools((await loadFixturePack()).tools);
const now = new Date(Date.UTC(2026, 10, 13));
const html = (body: string, scripts = "") => `<html><head><title>Acme</title>${scripts}</head><body>${body}</body></html>`;

describe("site facts", () => {
  it("reads CTAs, pricing and tools from scripts", () => {
    const f = extractSiteFacts(html(`<a href="/signup">Start for free</a><a href="/pricing">Pricing</a>`, `<script src="//js.hs-scripts.com/123.js"></script><script src="https://widget.intercom.io/widget/x"></script>`), rules.tools);
    expect(f).toMatchObject({ selfServe: true, salesLed: false, pricing: true, tools: ["hubspot", "intercom"] });
    expect(extractSiteFacts(html(`<button>Book a demo</button>`), rules.tools).salesLed).toBe(true);
  });
  it("inline tag snippets count (Google Ads conversion tag)", () => {
    expect(extractSiteFacts(html("", `<script>gtag('config', 'AW-12345');</script>`), rules.tools).tools).toEqual(["google_ads"]);
  });
});

describe("site diff", () => {
  const base = { salesLed: false, selfServe: true, pricing: false, tools: ["hubspot"] };
  it("baseline (first snapshot) emits nothing", () => {
    expect(diffSite("acme.com", null, { ...base, salesLed: true, pricing: true, tools: ["hubspot", "segment"] }, rules, now)).toEqual([]);
  });
  it("a switch to sales-led, a new pricing page and each new tool are separate events with unique URLs", () => {
    const ev = diffSite("acme.com", base, { salesLed: true, selfServe: false, pricing: true, tools: ["hubspot", "chilipiper", "segment"], ctas: ["Book a demo"] }, rules, now);
    expect(ev.map((e) => [e.type, e.url])).toEqual([
      ["cta_sales_led", "https://acme.com/#cta=sales-led"],
      ["pricing_page_added", "https://acme.com/#pricing"],
      ["gtm_tool_added", "https://acme.com/#tool=chilipiper"],
      ["gtm_tool_added", "https://acme.com/#tool=segment"],
    ]);
    expect(ev[0]!.quote).toBe('Homepage now says "Book a demo" (was self-serve)');
  });
  it("no change, no events; removing a tool isn't an event", () => {
    expect(diffSite("acme.com", base, { ...base, tools: [] }, rules, now)).toEqual([]);
  });
});

describe("dns", () => {
  it("maps SPF includes and verification tokens to tools; baseline emits nothing", () => {
    const tools = toolsFromTxt(["v=spf1 include:_spf.google.com include:servers.mcsv.net include:sendgrid.net ~all", "hubspot-developer-verification=abc"], rules);
    expect(tools).toEqual(["hubspot", "mailchimp", "sendgrid"]);
    expect(diffDnsTools("acme.com", null, tools, rules, now)).toEqual([]);
    expect(diffDnsTools("acme.com", ["mailchimp"], tools, rules, now).map((e) => e.url)).toEqual(["https://acme.com/#tool=hubspot", "https://acme.com/#tool=sendgrid"]);
  });
  it("stack sprawl at sprawl_min tools (site + DNS combined, deduped)", () => {
    expect(stackSprawl("acme.com", ["hubspot", "intercom", "hubspot", "segment"], rules, now)).toBeNull();
    expect(stackSprawl("acme.com", ["hubspot", "intercom", "segment", "mailchimp"], rules, now)?.url).toBe("https://acme.com/#stack");
  });
});

describe("funding and launches from YC pages", () => {
  it.each([
    ["YC alum Dropee, a Malaysia B2B wholesale platform, lands $7M Series A – TechCrunch", true],
    ["Acme raises ₹12 crore led by Blume", true],
    ["Acme closes seed round to build agents", true],
    ["Our favorite startups from YC's Summer 2023 Demo Day, Day 1 | TechCrunch", false],
    ["Acme raises the bar for invoice automation", false],
  ])("%s -> %s", (t, ok) => expect(isFundingHeadline(t)).toBe(ok));
  it("uses the real date; old news and undated items are dropped", () => {
    const ev = eventsFromYcProfile({
      news: [{ title: "Acme lands $3M seed round", url: "https://news.example/a", date: "Oct 20, 2026" }, { title: "Acme raises $10M Series A", url: "https://news.example/b", date: "Jan 05, 2024" }],
      launches: [{ title: "Acme - invoices on autopilot", url: "https://www.ycombinator.com/launches/x", createdAt: "2026-11-01T10:00:00Z" }, { title: "old", url: "u", createdAt: undefined }],
    }, now);
    expect(ev.map((e) => [e.type, e.observedAt.toISOString().slice(0, 10)])).toEqual([["funding_raise", "2026-10-20"], ["product_launch", "2026-11-01"]]);
  });
});

describe("tool overlap and sprawl exclusions", () => {
  it("two CRMs is overlap; ad pixels don't count toward sprawl", async () => {
    const { toolOverlap, stackSprawl } = await import("./watch.js");
    const now = new Date();
    const rules = { sprawlMin: 4, sprawlExclude: ["ads"], overlap: ["crm"], tools: [
      ["hubspot", "crm"], ["salesforce", "crm"], ["google_ads", "ads"], ["linkedin_ads", "ads"], ["intercom", "chat"],
    ].map(([key, category]) => ({ key: key!, label: key!, category: category!, site: [], dns: [] })) };
    expect(toolOverlap("acme.test", ["hubspot", "salesforce", "intercom"], rules, now)!.quote).toBe("2 crm tools: hubspot, salesforce");
    expect(toolOverlap("acme.test", ["hubspot", "intercom"], rules, now)).toBeNull();
    expect(stackSprawl("acme.test", ["hubspot", "google_ads", "linkedin_ads", "intercom"], rules, now)).toBeNull(); // 2 real tools, not 4
  });
});

describe("leaky capture", () => {
  it("fires only when a form leaks and no CRM shows on the site or in DNS", async () => {
    const { leakyCapture } = await import("./watch.js");
    const rules = { sprawlMin: 4, tools: [["hubspot", "crm"], ["intercom", "chat"]].map(([key, category]) => ({ key: key!, label: key!, category: category!, site: [], dns: [] })) };
    expect(leakyCapture("acme.test", ["typeform"], ["intercom"], rules, new Date())!.quote).toBe("Site form sends leads to typeform; no CRM detected");
    expect(leakyCapture("acme.test", ["typeform"], ["hubspot"], rules, new Date())).toBeNull();
    expect(leakyCapture("acme.test", [], [], rules, new Date())).toBeNull();
  });
});
