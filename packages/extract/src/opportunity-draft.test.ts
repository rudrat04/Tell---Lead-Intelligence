import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { draftProblems, writeOpportunityDraft, entityNames, type OppDraftInput } from "./opportunity-draft.js";

const input: OppDraftInput = {
  company: "Northwind Systems", opportunity: "Federal recompete", angle: "",
  events: [{ quote: `Contoso Federal LLC's $8.0M Department of Veterans Affairs contract for "it modernization support" (NAICS 541512) ends 2027-06-30`, url: "https://x.test", reasons: ["won 3 contracts in NAICS 541512"], about: "Contoso Federal LLC" }],
  record: ["Won $4.0M from Department of Veterans Affairs in 2025"],
};
const good = { subject: "a va it contract is ending", body: "A VA contractor's $8.0M IT modernization contract ends 2027-06-30. You've won 3 contracts in NAICS 541512 with the VA, so the recompete could suit you. We found it and a few others like it; we build a system that flags VA recompetes like this for your capture team. Want to see what we found?" };

describe("opportunity draft checks", () => {
  it("a short, factual draft that ends on a question passes", async () => {
    expect(draftProblems(good, input, await loadFixturePack())).toBe("");
  });
  it("rejects invented numbers, meeting asks, overclaims and a confirmed recompete", async () => {
    const pack = await loadFixturePack();
    expect(draftProblems({ ...good, body: good.body.replace("$8.0M", "$12M") }, input, pack)).toMatch(/number "12m" is not in the facts/);
    expect(draftProblems({ ...good, body: `${good.body.slice(0, -1)}. Free for a 15 min call?` }, input, pack)).toMatch(/asks for time/);
    expect(draftProblems({ ...good, body: `You're the only contractor who fits. ${good.body}` }, input, pack)).toMatch(/overclaims/);
    expect(draftProblems({ ...good, body: `The recompete is confirmed. ${good.body}` }, input, pack)).toMatch(/recompete as fact/);
    expect(draftProblems({ ...good, body: good.body.replace(/\?$/, ".") }, input, pack)).toMatch(/end on a question/);
  });
  it("never names the company behind the signal, and always pitches the system", async () => {
    const pack = await loadFixturePack();
    expect(draftProblems({ ...good, body: good.body.replace("A VA contractor's", "Contoso Federal's") }, input, pack)).toMatch(/names "Contoso Federal", the company behind the signal/);
    expect(draftProblems({ ...good, subject: "contoso's va contract" }, input, pack)).toMatch(/names "Contoso"/);
    expect(draftProblems({ ...good, body: good.body.replace("; we build a system that flags VA recompetes like this for your capture team", "") }, input, pack)).toMatch(/doesn't say we build systems/);
    expect(entityNames("Contoso Pharma Ltd.")).toEqual(["Contoso Pharma", "Contoso"]);
    // nothing that finds the company in one search, and no stock lines
    const news = { ...input, events: [{ quote: "Contoso Pharma to set up plant in Gujarat (Daily Business)", url: "u", reasons: ["offers granulation"], about: "Contoso Pharma" }] };
    const ok = { subject: "a new plant in gujarat", body: "A drug maker is setting up a plant in Gujarat. That could mean granulators. We built a system that flags plants like this for your sales team. Want to see what we found?" };
    expect(draftProblems(ok, news, pack)).toBe("");
    expect(draftProblems({ ...ok, body: ok.body.replace("Gujarat.", "Gujarat, per Daily Business.") }, news, pack)).toMatch(/names the outlet "Daily Business"/);
    expect(draftProblems({ ...ok, body: ok.body.replace("in Gujarat", "at 1200 W Fulton St") }, news, pack)).toMatch(/1200 W Fulton St/);
    expect(draftProblems({ ...ok, body: ok.body.replace("That could mean", "The move is") }, news, pack)).toMatch(/stock phrase "The move is"/);
    expect(entityNames("Global Health Services LLC")).toEqual(["Global Health Services"]);
  });
  it("rewrites with the reasons, then gives up (no template)", async () => {
    const pack = await loadFixturePack();
    const seen: string[] = [];
    const bad = { complete: async ({ user }: { user: string }) => { seen.push(user); return JSON.stringify({ subject: "x", body: "Let's book a call." }); } };
    const r = await writeOpportunityDraft(bad, pack, input);
    expect(r.draft).toBeNull();
    expect(seen.at(-1)).toMatch(/failed these checks/);
    const ok = { complete: async () => JSON.stringify(good) };
    expect((await writeOpportunityDraft(ok, pack, input)).draft).toEqual(good);
  });
});
