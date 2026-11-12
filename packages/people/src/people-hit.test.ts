import { describe, it, expect } from "vitest";
import { toRegex } from "@tell/config";
import { parseExaPerson } from "@tell/watchers";
import { acceptPeopleHit } from "./contacts.js";

const marketing = ["(?i)\\b(cmo|chief marketing officer|head of marketing|vp,? (of )?marketing|marketing director|director of marketing)\\b"].map(toRegex);
const revops = ["(?i)\\b(rev ?ops|revenue operations|sales operations|marketing operations)\\b"].map(toRegex);

/** Shape of a real Exa "people" result (Nov 2026). */
const exa = (name: string, work: { title: string; company: string; to?: string | null }[]) => ({
  title: name, url: `https://linkedin.com/in/${name.toLowerCase().replace(/ /g, "-")}`,
  entities: [{ type: "person", properties: { name, workHistory: work.map((w) => ({ title: w.title, company: { name: w.company }, dates: { from: "2025-01-01", to: w.to ?? null } })) } }],
});

describe("people search hits", () => {
  it("parses Exa's structured person: current roles have no end date", () => {
    expect(parseExaPerson(exa("Mina Example", [{ title: "CMO", company: "Deepgram" }, { title: "VP Marketing", company: "Old Co", to: "2026-05-01" }]))).toEqual({
      name: "Mina Example", url: "https://linkedin.com/in/mina-example",
      roles: [{ title: "CMO", company: "Deepgram", current: true }, { title: "VP Marketing", company: "Old Co", current: false }],
    });
    expect(parseExaPerson({ title: "x", url: "u" })).toBeNull();
  });
  it("accepts the persona in a current role at the same company", () => {
    expect(acceptPeopleHit(parseExaPerson(exa("Mina Example", [{ title: "CMO", company: "Deepgram" }]))!, "Deepgram", "deepgram.com", marketing))
      .toMatchObject({ name: "Mina Example", role: "CMO at Deepgram", source: "exa", linkedin: "https://linkedin.com/in/mina-example" });
  });
  it("rejects someone who has left (real case: RevOps manager who moved from Roboflow to Sourcegraph)", () => {
    const moved = parseExaPerson(exa("Jordan Example", [{ title: "Revenue Strategy and Operations Manager", company: "Sourcegraph" }, { title: "Revenue Operations Manager", company: "Roboflow", to: "2026-05-01" }]))!;
    expect(acceptPeopleHit(moved, "Roboflow", "roboflow.com", revops)).toBeNull();
  });
  it("rejects other roles, other companies and lookalike company names", () => {
    expect(acceptPeopleHit(parseExaPerson(exa("A B", [{ title: "Software Engineer", company: "Deepgram" }]))!, "Deepgram", "deepgram.com", marketing)).toBeNull();
    expect(acceptPeopleHit(parseExaPerson(exa("A B", [{ title: "CMO", company: "Deepgram Labs Europe" }]))!, "Deepgram", "deepgram.com", marketing)).toBeNull();
    expect(acceptPeopleHit(parseExaPerson(exa("A B", [{ title: "CMO", company: "Acmecorp" }]))!, "Acme", "acme.com", marketing)).toBeNull();
  });
  it("company suffixes don't matter (Acme Labs Inc = Acme Labs)", () => {
    expect(acceptPeopleHit(parseExaPerson(exa("A B", [{ title: "Head of Marketing", company: "Acme Labs, Inc." }]))!, "Acme Labs", "acmelabs.com", marketing)).not.toBeNull();
  });
});
