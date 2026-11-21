import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { OppLead } from "@tell/pipeline";
import { oppMessage, oppSheetRow, oppBrief, draftText, oppContext } from "./opportunities.js";

const NOW = new Date("2026-11-21T00:00:00Z");
const lead: OppLead = {
  account: { id: "a1", domain: "northwind.example", name: "Northwind Systems", description: "IT modernization for civilian agencies", region: "United States of America", sizeBand: "11-50", segment: "govcon" },
  opportunity: { id: "federal_recompete", kind: "usaspending_expiring", follow: "", label: "Federal recompete", angle: "Capture starts months before the RFP.", buyers: ["Founder / CEO"] },
  score: { score: 71, parts: { opportunity: 30, fit: 23, timing: 12, buyer: 6 }, line: "Score 71 = opportunity 30 · fit 23 · timing 12 · buyer 6" },
  events: [{ id: "e1", quote: "Contoso Federal LLC's $8.0M Department of Veterans Affairs contract for \"it support\" (NAICS 541512) ends 2027-06-30", url: "https://www.usaspending.gov/award/X", amount: 8e6,
    endDate: new Date("2027-06-30T00:00:00Z"), agency: "Department of Veterans Affairs", naics: "541512", setAside: null, entityName: "Contoso Federal LLC", fit: 0.9, reasons: ["won 3 contracts in NAICS 541512"], firstSeenAt: NOW }],
  evidence: [{ quote: "Won $4.0M from Department of Veterans Affairs in 2025", url: "https://www.usaspending.gov/award/Y" }],
  facts: { naics: { "541512": 3 }, agencies: {}, subAgencies: {}, setAsides: [], awards: 3, total: 9e6, largest: 4e6, lastAwardAt: null, ueis: [], states: [], evidence: [] },
  contact: { person: { name: "Asha Rao", role: "VP Business Development", source: "exa", linkedin: "https://linkedin.example/in/asha" }, persona: "Founder / CEO", note: "" },
};

describe("opportunity lead out", () => {
  it("Telegram: the opportunity, who to reach, the event with why it fits, and the buttons (Create draft, no draft text)", () => {
    const m = oppMessage(lead, "11111111-2222-4333-8444-555555555555", NOW);
    expect(m.text).toContain("Federal recompete");
    expect(m.text.indexOf("THE SIGNAL")).toBeLessThan(m.text.indexOf("WHO CAN BENEFIT"));
    expect(m.text.indexOf("WHO CAN BENEFIT")).toBeLessThan(m.text.indexOf("THE PLAY"));
    expect(m.text.indexOf("THE PLAY")).toBeLessThan(m.text.indexOf("THE OPPORTUNITY"));
    expect(m.text).toContain("<b>Reach:</b> Asha Rao, VP Business Development");
    expect(m.text).toContain("<b>How:</b> won 3 contracts in NAICS 541512");
    expect(m.text).not.toContain("Subject:");
    expect(m.buttons!.flat().map((b) => b.data)).toEqual(expect.arrayContaining(["cd:11111111-2222-4333-8444-555555555555", "br:11111111-2222-4333-8444-555555555555", "e:11111111-2222-4333-8444-555555555555"]));
    expect(oppMessage(lead, null, NOW, true).buttons).toBeUndefined();
  });
  it("Sheet: the Email draft cell holds the Create draft link; the brief says a recompete is not a confirmed RFP", () => {
    const r = oppSheetRow(lead, "2026-11-21", NOW, { draft: "https://w.example/cd?d=x&s=y", enrich: "https://w.example/e?d=x&s=z" });
    expect(r["Email draft"]).toBe("https://w.example/cd?d=x&s=y");
    expect(r.Opportunity).toBe("Federal recompete");
    expect(r.Signal).toMatch(/^Contoso Federal LLC's \$8\.0M/);
    expect(r["Signal date"]).toBe("ends 2027-06-30 (in 221 days)");
    expect(r.About).toBe("Contoso Federal LLC");
    expect(r["Why they benefit"]).toBe("won 3 contracts in NAICS 541512");
    expect(r.Timing).toBe("ends 2027-06-30 (221 days)");
    const brief = oppBrief(lead, NOW);
    expect(brief).toMatch(/not a confirmed RFP/);
    // pitch order: signal, who benefits and how, the play, the opportunity, who to reach
    const order = ["1. THE SIGNAL", "2. WHO CAN BENEFIT", "3. THE PLAY", "4. THE OPPORTUNITY", "5. WHO TO REACH"].map((h) => brief.indexOf(h));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]!))).toBe(true);
  });
  it("the draft gets the code-written greeting and signature", async () => {
    const pack = await loadFixturePack();
    const t = draftText(oppContext(lead, NOW), { subject: "va contract", body: "Body?" }, pack);
    expect(t.split("\n")[0]).toBe("Subject: va contract");
    expect(t).toContain("Asha");
  });
});
