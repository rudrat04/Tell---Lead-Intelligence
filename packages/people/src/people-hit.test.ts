import { describe, it, expect } from "vitest";
import { toRegex } from "@tell/config";
import { parseProfileTitle } from "@tell/watchers";
import { acceptPeopleHit } from "./contacts.js";

const marketing = ["(?i)\\b(cmo|chief marketing officer|head of marketing|vp,? (of )?marketing|marketing director|director of marketing)\\b"].map(toRegex);
const hit = (title: string, text = "") => ({ title, url: "https://www.linkedin.com/in/jane-doe", text });
const accept = (title: string, text = "", company = "Acme Labs", domain = "acme.com") => acceptPeopleHit(hit(title, text), parseProfileTitle(title), company, domain, marketing);

describe("people search hits", () => {
  it("parses common headline shapes", () => {
    expect(parseProfileTitle("Jane Doe - Head of Marketing at Acme | LinkedIn")).toEqual({ name: "Jane Doe", headline: "Head of Marketing at Acme" });
    expect(parseProfileTitle("José García – CMO – Acme")).toEqual({ name: "José García", headline: "CMO - Acme" });
    expect(parseProfileTitle("Acme Labs | LinkedIn")).toBeNull();
    expect(parseProfileTitle("Top 10 CMOs 2026 - Acme")).toBeNull();
  });
  it("accepts the persona at the same company, with the profile link", () => {
    expect(accept("Jane Doe - Head of Marketing at Acme Labs | LinkedIn")).toMatchObject({ name: "Jane Doe", source: "exa", linkedin: "https://www.linkedin.com/in/jane-doe" });
    expect(accept("Jane Doe - CMO", "Chief Marketing Officer at Acme. Previously...")).not.toBeNull();
  });
  it("rejects other companies, other roles, and lookalike names (never guess)", () => {
    expect(accept("Jane Doe - Head of Marketing at Globex | LinkedIn")).toBeNull();
    expect(accept("Jane Doe - Software Engineer at Acme Labs | LinkedIn")).toBeNull();
    expect(accept("Jane Doe - Head of Marketing at Acmecorp | LinkedIn")).toBeNull();
  });
});
