import { describe, it, expect } from "vitest";
import { verifyPost, verifierPrompt } from "./verifier.js";
import type { LlmClient, PostExtraction } from "./post.js";

const reply = (o: unknown): LlmClient => ({ complete: async () => JSON.stringify(o) });
const positive = { self_promotion: false, author_role: "founder" } as unknown as PostExtraction;

describe("Gate 4 verifier parsing", () => {
  it("cuts a long reason instead of rejecting the verdict", async () => {
    const r = await verifyPost(reply({ genuine_need: true, disqualifier: "none", reason: "x".repeat(900) }), "post", positive, "a B2B team");
    expect(r.decision).toBe("confirm");
  });
  it("maps near-miss disqualifiers onto the enum", async () => {
    const r = await verifyPost(reply({ genuine_need: false, disqualifier: "Job seeker", reason: "wants a job" }), "post", positive, "a B2B team");
    expect(r.decision).toBe("uncertain"); // gate 3 said positive, gate 4 says job_seeker: they disagree
    if (r.decision === "uncertain") expect(r.reason).toContain("job_seeker");
    const v = await verifyPost(reply({ genuine_need: false, disqualifier: "self_promotion", reason: "an ad" }), "post", { ...positive, self_promotion: true }, "a B2B team");
    expect(v.decision).toBe("reject");
  });
  it("names the field when the reply still doesn't fit", async () => {
    const r = await verifyPost(reply({ genuine_need: "maybe", disqualifier: "none", reason: "?" }), "post", positive, "a B2B team");
    expect(r).toEqual({ decision: "uncertain", reason: "verifier schema mismatch (genuine_need)" });
  });
});

describe("Gate 4 verifier prompt", () => {
  // false-positive class (Nov 2026): "looking for a freelancer to set up our lead gen" was called a recruiter post
  it("treats hiring a freelancer/agency for your own company as the buyer, not a recruiter", () => {
    const p = verifierPrompt("a B2B team");
    expect(p).toMatch(/freelancer, contractor, consultant or agency[^.]*OWN company is a GENUINE need/);
    expect(p).toMatch(/"recruiter" means hiring on behalf of another company/);
  });
});
