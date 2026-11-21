import { describe, it, expect } from "vitest";
import { loadFixturePack, type Pack } from "@tell/config";
import { validateResearch, researchPrompt } from "./buyers.js";
import { analyzeLead, validateAnalysis, analystUserPrompt, type AnalystInput } from "./analyst.js";

const base = await loadFixturePack();
const ind = (label: string) => ({ label, aliases: [], description: `${label} companies`, buyers: [], list: "manual" as const, excluded: false });
const change = (id: string, whose: "customers" | "competitors" | "channel" | "market", industries: string[] = []) => ({ id, title: `${id} title`, whose, signals: ["funding_raise"], industries, live: "db" as const, why: "why it matters here", action: "what to do about it" });
const pack: Pack = { ...base, icp: { ...base.icp, industries: { pharma: ind("Pharma"), food: ind("Food"), consumer: { ...ind("Consumer"), excluded: true } } },
  modules: { modules: [{ id: "pharma_market", title: "Pharma market watch", industries: ["pharma"], offer: "a weekly watch on your market", changes: [change("biotechs_funded", "customers"), change("rival_approvals", "competitors"), change("supply_gaps", "market", ["pharma"])] }] } };

describe("research (who pays them, which changes matter)", () => {
  const ok = { sells: "contract drug discovery", who: "biotech companies", customers: ["pharma", "spaceships", "consumer"], channel: "direct", module: "pharma_market", changes: ["biotechs_funded", "rival_approvals", "made_up"], fit: { biotechs_funded: 5, rival_approvals: 4, supply_gaps: 4, made_up: 5 }, why: { biotechs_funded: "new money funds new discovery programs", made_up: "x" }, places: ["Hyderabad", "Telangana"], keywords: ["Discovery Chemistry", "x"] };
  it("keeps the pack's industries, the module's changes and a why per change", () => {
    const r = validateResearch(JSON.stringify(ok), pack);
    expect(r).toMatchObject({ customers: ["pharma"], module: "pharma_market", changes: ["biotechs_funded", "rival_approvals", "supply_gaps"], why: { biotechs_funded: "new money funds new discovery programs" } });
  });
  it("a customers change without customer industries has nowhere to look: dropped", () => {
    const r = validateResearch(JSON.stringify({ ...ok, customers: [], changes: ["biotechs_funded", "rival_approvals", "supply_gaps"] }), pack);
    expect(r?.changes).toEqual(["rival_approvals", "supply_gaps"]);
    expect(validateResearch(JSON.stringify({ ...ok, changes: ["Drug companies with new money", "x"] }), pack)?.changes).toEqual(["biotechs_funded", "rival_approvals", "supply_gaps"]);
  });
  it("a change rated under 4 for this business is not kept (no developer news for a federal road builder)", () => {
    expect(validateResearch(JSON.stringify({ ...ok, fit: { biotechs_funded: 5, rival_approvals: 3, supply_gaps: 4 }, changes: ["biotechs_funded", "rival_approvals", "supply_gaps"] }), pack)?.changes).toEqual(["biotechs_funded", "supply_gaps"]);
    expect(validateResearch(JSON.stringify(ok), pack)?.places).toEqual(["Hyderabad", "Telangana"]);
    expect(validateResearch(JSON.stringify(ok), pack)?.keywords).toEqual(["discovery chemistry"]);
  });
  it("'who' describing the company itself falls back to its customers' industries", () => {
    expect(validateResearch(JSON.stringify({ ...ok, who: "A federal IT contractor that wins agency work" }), pack)?.who).toBe("pharma");
  });
  it("unknown module, or no change rated a strong fit = no research", () => {
    expect(validateResearch(JSON.stringify({ ...ok, module: "nope" }), pack)).toBeNull();
    expect(validateResearch(JSON.stringify({ ...ok, fit: { biotechs_funded: 2, rival_approvals: 3, supply_gaps: 1 } }), pack)).toBeNull();
  });
  it("the prompt says customers are who PAYS them, and lists the industry's module first", () => {
    expect(researchPrompt(pack, "pharma")).toContain("are the companies that PAY this company");
    expect(researchPrompt(pack, "pharma")).toContain("Module pharma_market");
  });
});

describe("plain words and the closing pitch", () => {
  const copy = { ...base.copy, pitch: { idea: "", variants: ["I keep watching your market so your team reaches new buyers first."], by_play: {} },
    plain_words: { banned: ["pipeline", "GTM"], allow_segments: ["software"] } };
  const p2: Pack = { ...pack, copy };
  const input: AnalystInput = { company: "Northwind Films", domain: "northwind.test", facts: "", contactRole: "Head of Sales", segment: "food",
    plays: [{ id: "x", title: "New plant", angle: "a" }], evidence: [{ type: "market_change", ageDays: 3, current: false, quote: "Your buyers are building new capacity. Contoso Foods: commissions a snack plant in Nashik", url: "https://news.example/1" }] };
  it("the pitch and the plain-words rule reach the prompt for a niche reader", async () => {
    let seen = "";
    await analyzeLead({ complete: async (a) => { seen = a.user; return "{}"; } }, p2, input);
    expect(seen).toContain("What you do, for this email's closing line");
    expect(seen).toContain('never these words: "pipeline", "GTM"');
    expect(analystUserPrompt({ ...input })).not.toContain("Plain words only");
  });
  it("a draft that says 'pipeline' to a food maker is rejected; a software reader may hear it", () => {
    const draft = { hypothesis: "Their buyers are expanding.", angle: "buyers", opener: "saw Contoso Foods is adding a plant", citations: [0], counter_evidence: null, confidence: 0.6,
      email_subject: "snack plant", email_body: "saw Contoso Foods commissions a snack plant in Nashik.\n\nI build pipeline from moments like this.\n\nwho handles new buyers for you?", linkedin_message: "saw the Nashik plant news. how do you hear about new plants usually?" };
    const niche = validateAnalysis(JSON.stringify(draft), input, { plain: ["pipeline"] });
    expect(niche?.email).toBeNull();
    expect(niche?.emailProblems?.join()).toMatch(/words this reader doesn't use \("pipeline"\)/);
    expect(validateAnalysis(JSON.stringify(draft), input, { plain: [] })?.email).not.toBeNull();
  });
});
