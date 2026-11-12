import { describe, it, expect } from "vitest";
import { extractPost, isGrounded, type LlmClient } from "./post.js";

const text = "Our CRM is a mess. Looking for a freelancer to set up HubSpot and outbound ASAP.";
const good = {
  author_role: "founder", ask_type: "hire", problem_category: "crm", company_identifiable: false, company_name: null,
  urgency_or_budget_hint: true, self_promotion: false, strength: 5, evidence_quote: "Looking for a freelancer to set up HubSpot",
};
const llm = (o: unknown): LlmClient => ({ complete: async () => (typeof o === "string" ? o : JSON.stringify(o)) });

describe("extractPost", () => {
  it("accepts a grounded extraction", async () => {
    const r = await extractPost(llm(good), text);
    expect(r.ok).toBe(true);
  });
  it("rejects a fabricated quote", async () => {
    const r = await extractPost(llm({ ...good, evidence_quote: "We have a $50k budget for this" }), text);
    expect(r).toEqual({ ok: false, reason: "ungrounded" });
  });
  it("rejects bad schema and bad JSON", async () => {
    expect(await extractPost(llm({ ...good, strength: 9 }), text)).toMatchObject({ ok: false, reason: "schema", detail: expect.stringContaining("strength") });
    expect(await extractPost(llm("nope"), text)).toEqual({ ok: false, reason: "invalid_json" });
  });
  it("caps strength for self-promotion (injection can't raise it)", async () => {
    const r = await extractPost(llm({ ...good, self_promotion: true, strength: 5 }), text);
    expect(r.ok && r.extraction.strength).toBe(1);
  });
  it("caps venting at 3", async () => {
    const r = await extractPost(llm({ ...good, ask_type: "venting", strength: 5 }), text);
    expect(r.ok && r.extraction.strength).toBe(3);
  });
  it("grounding ignores whitespace and case", () => expect(isGrounded("OUR  crm is\na mess", text)).toBe(true));
});
