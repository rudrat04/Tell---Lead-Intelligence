import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { OppLead } from "@tell/pipeline";
import { oppMessage, oppSheetRow, oppBrief, draftText, oppContext, bySignal, signalMessage } from "./opportunities.js";

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
  it("a fact-checked news lead shows what happened, the stage with its quote and what they will need", () => {
    const news: OppLead = { ...lead, opportunity: { ...lead.opportunity, id: "in_pharma_plant", kind: "news", label: "Pharma plant build-out" },
      events: [{ ...lead.events[0]!, quote: "Contoso Lifesciences starts building oral solid plant (Example News)", url: "https://news.example/a", stage: "committed",
        happened: "Contoso Lifesciences has started construction of a new oral solid dosage plant in Gujarat.", stageQuote: "has started construction of its new oral solid dosage plant",
        need: { what: "tablet compression and granulation machines", supplier: "pharma process equipment maker", industry: "manufacturing", quote: "will make 2 billion tablets a year" },
        reasons: ["based in India", "they will need tablet compression and granulation machines", "stage: committed (\"has started construction\")"] }] };
    const m = oppMessage(news, "11111111-2222-4333-8444-555555555555", NOW).text;
    expect(m).toContain("Fact-checked: Contoso Lifesciences has started construction");
    expect(m).toContain("Stage: committed (approved, funded, building, ordering): \"has started construction of its new oral solid dosage plant\"");
    expect(m).toContain("<b>They will need:</b> tablet compression and granulation machines");
    expect(m).not.toMatch(/How:.*stage:/); // the stage shows once, under the signal
    expect(oppBrief(news, NOW)).toContain("They will need: tablet compression and granulation machines (from: \"will make 2 billion tablets a year\")");
  });
  it("one signal, several businesses: grouped under one signal message, each business sent without repeating it", () => {
    const ev = { ...lead.events[0]!, quote: "Fabrikam Beverages lays foundation of a soft drink plant (Example News)", url: "https://news.example/plant", stage: "committed" as const,
      happened: "Fabrikam Beverages laid the foundation stone of a soft drink plant in Nashik.", stageQuote: "laid the foundation stone" };
    const mk = (id: string, name: string, score: number, what: string): typeof lead => ({ ...lead, account: { ...lead.account, id, name, domain: `${id}.example` },
      opportunity: { ...lead.opportunity, id: `trade:${id}`, kind: "signals", label: what }, score: { ...lead.score, score },
      events: [{ ...ev, need: { what, supplier: what, industry: "manufacturing", quote: "laid the foundation stone" } }] });
    const other = { ...mk("c", "Woodgrove Staffing", 70, "plant workers"), events: [{ ...ev, url: "https://news.example/other" }] };
    const groups = bySignal([mk("a", "Northwind Builders", 60, "factory construction"), other, mk("b", "Contoso Filling", 65, "bottling lines")]);
    expect(groups.map((g) => g.map((l) => l.account.name))).toEqual([["Woodgrove Staffing"], ["Contoso Filling", "Northwind Builders"]]);
    const head = signalMessage(groups[1]!, NOW).text;
    expect(head).toContain("2 businesses can act on it:</b> Contoso Filling · Northwind Builders");
    expect(head).toContain("• bottling lines");
    expect(oppMessage(groups[1]![0]!, null, NOW, true, true).text).not.toContain("THE SIGNAL");
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

describe("only verified emails, and who deals with it on the signal's side", () => {
  const news: OppLead = { ...lead, opportunity: { ...lead.opportunity, id: "in_solar", kind: "news", label: "Rooftop solar tender" },
    events: [{ ...lead.events[0]!, quote: "Contoso Power invites bids for rooftop solar (Example News)", url: "https://news.example/solar", entityName: "Contoso Power" }],
    signalContacts: [{ name: "Ravi Sen", role: "Head of Procurement", linkedin: "https://www.linkedin.com/in/ravi-sen" }] };
  it("a guessed or likely address is never shown: no Email cell, the Find email button stays", () => {
    const guessed = { ...news, contact: { ...news.contact!, person: { ...news.contact!.person, email: { address: "asha.rao@northwind.example", status: "likely" as const, note: "pattern" } } } };
    const row = oppSheetRow(guessed, "2026-11-21", NOW, { enrich: "https://w.example/e?d=x&s=z" });
    expect(row.Email).toBeUndefined();
    expect(row["Enrich email"]).toBe("https://w.example/e?d=x&s=z");
    const m = oppMessage(guessed, "11111111-2222-4333-8444-555555555555", NOW);
    expect(m.text).not.toContain("asha.rao@");
    expect(oppBrief(guessed, NOW)).not.toContain("asha.rao@");
    expect(m.buttons!.flat().map((b) => b.data)).toContain("e:11111111-2222-4333-8444-555555555555");
    const sure = { ...guessed, contact: { ...guessed.contact, person: { ...guessed.contact.person, email: { address: "asha.rao@northwind.example", status: "verified" as const, note: "verified (QuickEmailVerification)" } } } };
    expect(oppSheetRow(sure, "2026-11-21", NOW, {}).Email).toBe("asha.rao@northwind.example");
    expect(oppMessage(sure, "11111111-2222-4333-8444-555555555555", NOW).buttons!.flat().map((b) => b.data)).not.toContain("e:11111111-2222-4333-8444-555555555555");
  });
  it("the signal's company contact shows on the signal message, the lead, the brief and the Sheet", () => {
    expect(signalMessage([news], NOW).text).toContain("Who deals with it at Contoso Power:</b>");
    expect(signalMessage([news], NOW).text).toContain(">Ravi Sen</a>, Head of Procurement");
    expect(oppMessage(news, null, NOW, true).text).toContain("Ravi Sen");
    expect(oppMessage(news, null, NOW, true, true).text).not.toContain("Ravi Sen"); // compact: the signal message has it
    expect(oppBrief(news, NOW)).toContain("On the signal's side (Contoso Power, who deals with it): Ravi Sen, Head of Procurement (https://www.linkedin.com/in/ravi-sen)");
    expect(oppSheetRow(news, "2026-11-21", NOW, {})["Signal-side contact"]).toBe("Contoso Power: Ravi Sen, Head of Procurement (https://www.linkedin.com/in/ravi-sen)");
  });
});

describe("signal-side emails on a click", () => {
  const news: OppLead = { ...lead, opportunity: { ...lead.opportunity, id: "in_solar", kind: "news", label: "Rooftop solar tender" },
    events: [{ ...lead.events[0]!, quote: "Contoso Power invites bids (Example News)", url: "https://news.example/solar", entityName: "CPWR" }],
    signalEntity: "Contoso Power Works", signalContacts: [{ name: "Ravi Sen", role: "Head of Procurement", linkedin: "https://www.linkedin.com/in/ravi-sen" }] };
  it("a Signal-side email button and Sheet link while someone there has no verified address; the context keeps the people", () => {
    const m = oppMessage(news, "11111111-2222-4333-8444-555555555555", NOW);
    expect(m.buttons!.flat().map((b) => b.data)).toContain("es:11111111-2222-4333-8444-555555555555");
    expect(oppSheetRow(news, "2026-11-21", NOW, { enrichSignal: "https://w.example/e?side=signal" })["Signal-side email"]).toBe("https://w.example/e?side=signal");
    expect(oppContext(news, NOW).signal).toEqual({ entity: "CPWR", full: "Contoso Power Works", people: news.signalContacts });
    const done = { ...news, signalContacts: [{ ...news.signalContacts![0]!, email: { address: "ravi.sen@cpwr.example", status: "verified" as const, note: "" } }] };
    expect(oppMessage(done, "11111111-2222-4333-8444-555555555555", NOW).buttons!.flat().map((b) => b.data)).not.toContain("es:11111111-2222-4333-8444-555555555555");
    expect(oppSheetRow(done, "2026-11-21", NOW, {})["Signal-side contact"]).toContain("ravi.sen@cpwr.example (verified)");
  });
});
