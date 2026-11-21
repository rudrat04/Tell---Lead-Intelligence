import { describe, it, expect } from "vitest";
import { loadFixturePack, type Pack } from "@tell/config";
import { validateBuyers, buyerPrompt } from "./buyers.js";
import { analyzeLead, validateAnalysis, analystUserPrompt, type AnalystInput } from "./analyst.js";

const base = await loadFixturePack();
const ind = (label: string) => ({ label, aliases: [], description: `${label} companies`, buyers: [], list: "manual" as const, excluded: false });
const pack: Pack = { ...base, icp: { ...base.icp, industries: { food: ind("Food"), pharma: ind("Pharma"), consumer: { ...ind("Consumer"), excluded: true } } } };

describe("buyer profile", () => {
  it("keeps only the pack's industries and demand signals", () => {
    const p = validateBuyers(JSON.stringify({ industries: ["food", "pharma", "spaceships", "consumer"], signals: ["funding_raise", "made_up", "core_role_filled"], who: "food and pharma makers" }), pack);
    expect(p).toEqual({ industries: ["food", "pharma"], signals: ["funding_raise"], who: "food and pharma makers" });
  });
  it("nothing usable = no profile (the draft goes without a sample)", () => {
    expect(validateBuyers(JSON.stringify({ industries: ["spaceships"], signals: ["funding_raise"], who: "x" }), pack)).toBeNull();
    expect(validateBuyers("no idea", pack)).toBeNull();
  });
  it("the prompt lists only admitted industries", () => {
    expect(buyerPrompt(pack)).toContain("- food: Food companies");
    expect(buyerPrompt(pack)).not.toContain("consumer:");
  });
});

describe("plain words and the closing pitch", () => {
  const copy = { ...base.copy, pitch: { idea: "", variants: ["I keep watching your market so your team reaches new buyers first."], by_play: {} },
    plain_words: { banned: ["pipeline", "GTM"], allow_segments: ["software"] } };
  const p2: Pack = { ...pack, copy };
  const input: AnalystInput = { company: "Northwind Films", domain: "northwind.test", facts: "", contactRole: "Head of Sales", segment: "food",
    plays: [{ id: "x", title: "New plant", angle: "a" }], evidence: [{ type: "capacity_expansion", ageDays: 3, current: false, quote: "Contoso Foods: commissions a snack plant in Nashik", url: "https://news.example/1" }] };
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
