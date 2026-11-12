import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.js";
import type { LlmClient } from "./post.js";

const text = "Our CRM is a mess. Looking for a freelancer to set up HubSpot and outbound ASAP.";
const g3 = { author_role: "founder", ask_type: "hire", problem_category: "crm", company_identifiable: false, company_name: null, urgency_or_budget_hint: true, self_promotion: false, strength: 5, evidence_quote: "Looking for a freelancer to set up HubSpot" };
const ok = { genuine_need: true, disqualifier: "none", reason: "real ask" };

/** Returns replies in order: gate3 then gate4 */
const seq = (...r: unknown[]): LlmClient => { let i = 0; return { complete: async () => JSON.stringify(r[i++]) }; };

const extractor = { need_description: "a company that needs external GTM engineering help with CRM and outbound", categories: ["crm", "outbound"], strength_5: "explicitly hiring someone for CRM work now" };
const pass1 = () => ({ pass: true, reason: "passed", injectionFlag: false });

describe("cascade", () => {
  it("confirms when all gates agree", async () => {
    const r = await runCascade({ llm: seq(g3, ok), gate1: pass1, extractor }, text);
    expect(r.status).toBe("confirmed");
  });
  it("rejects at gate 1 without calling the LLM", async () => {
    let calls = 0;
    const llm: LlmClient = { complete: async () => { calls++; return "{}"; } };
    const r = await runCascade({ llm, gate1: () => ({ pass: false, reason: "never", injectionFlag: false }), extractor }, text);
    expect(r.status).toBe("rejected");
    expect(calls).toBe(0);
  });
  it("sends injection-flagged items to uncertain, no LLM", async () => {
    const r = await runCascade({ llm: seq(), gate1: () => ({ pass: true, reason: "x", injectionFlag: true }), extractor }, text);
    expect(r.status).toBe("uncertain");
  });
  it("gate 3/4 disagreement is uncertain", async () => {
    const r = await runCascade({ llm: seq(g3, { genuine_need: false, disqualifier: "vendor", reason: "agency pitch" }), gate1: pass1, extractor }, text);
    expect(r).toMatchObject({ status: "uncertain", gate: 4 });
  });
  it("self-promotion is rejected at gate 3 without a gate 4 call", async () => {
    let calls = 0;
    const llm: LlmClient = { complete: async () => { calls++; return JSON.stringify({ ...g3, self_promotion: true }); } };
    const r = await runCascade({ llm, gate1: pass1, extractor }, text);
    expect(r).toMatchObject({ status: "rejected", gate: 3 });
    expect(calls).toBe(1);
  });
  it("low-strength (unrelated) posts are rejected at gate 3, not sent to uncertain", async () => {
    const r = await runCascade({ llm: seq({ ...g3, ask_type: "other", strength: 1 }), gate1: pass1, extractor }, text);
    expect(r).toMatchObject({ status: "rejected", gate: 3, reason: "no need (low strength)" });
  });
  it("fabricated quote rejected at gate 3", async () => {
    const r = await runCascade({ llm: seq({ ...g3, evidence_quote: "budget is $50k" }), gate1: pass1, extractor }, text);
    expect(r).toMatchObject({ status: "rejected", gate: 3 });
  });
});
