import { describe, it, expect } from "vitest";
import { reachFactor } from "./reach.js";

const r = { no_contact: 0.5, no_email: 0.7, guessed_email: 0.85, off_persona: 0.8 };
const contact = (status: "observed" | "likely" | "guessed" | null, persona: string | null = "RevOps lead") =>
  ({ person: { name: "Mila Osk", role: "Head of RevOps", source: "exa", email: status ? { address: "mila@acme.test", status, note: "" } : null }, persona, note: "" });

describe("reach factor", () => {
  it("full marks for the problem owner with a known-good email", () => {
    expect(reachFactor(contact("likely"), ["RevOps lead"], r)).toBe(1);
  });
  it("down-weights a guessed email, a missing email, the wrong persona and no contact", () => {
    expect(reachFactor(contact("guessed"), ["RevOps lead"], r)).toBe(0.85);
    expect(reachFactor(contact(null), ["RevOps lead"], r)).toBe(0.7);
    expect(reachFactor(contact("likely", "Founder / CEO"), ["RevOps lead"], r)).toBe(0.8);
    expect(reachFactor(null, ["RevOps lead"], r)).toBe(0.5);
  });
});
