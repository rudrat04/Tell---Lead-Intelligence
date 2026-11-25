import { describe, it, expect } from "vitest";
import { afterVerify, fromFinder } from "./email-apis.js";

const guess = { address: "asha@northwind.test", status: "likely" as const, note: "first@ pattern" };
describe("email upgrades", () => {
  it("verification: valid = verified; catch-all stays likely with a note; invalid or disposable = invalid; unknown changes nothing", () => {
    expect(afterVerify(guess, { result: "valid", acceptAll: false, disposable: false }).status).toBe("verified");
    expect(afterVerify(guess, { result: "valid", acceptAll: true, disposable: false })).toMatchObject({ status: "likely", note: "first@ pattern · catch-all domain (accepts any address)" });
    expect(afterVerify(guess, { result: "invalid", acceptAll: false, disposable: false }).status).toBe("invalid");
    expect(afterVerify(guess, { result: "unknown", acceptAll: false, disposable: false })).toEqual(guess);
  });
  it("a finder's address is verified only when the finder verified it: a high score alone is still a guess", () => {
    expect(fromFinder({ address: "a@b.test", score: 91, verified: false }, "Hunter")?.status).toBe("likely");
    expect(fromFinder({ address: "a@b.test", score: 91, verified: true }, "Hunter")?.status).toBe("verified");
    expect(fromFinder({ address: "a@b.test", score: 50, verified: false }, "Hunter")).toEqual({ address: "a@b.test", status: "likely", note: "found by Hunter (score 50)" });
    expect(fromFinder(null, "Prospeo")).toBeNull();
  });
});

import { needsSecondCheck } from "./email-apis.js";
describe("the second verifier (InboxTrue) never changes a verdict QuickEmailVerification gave", () => {
  const guess = { address: "jane@contoso.com", status: "likely" as const, note: "first@ pattern" };
  it("asked only when the first gave no verdict", () => {
    expect(needsSecondCheck(null)).toBe(true);
    expect(needsSecondCheck({ result: "unknown", acceptAll: false, disposable: false })).toBe(true);
    expect(needsSecondCheck({ result: "valid", acceptAll: false, disposable: false })).toBe(false);
    expect(needsSecondCheck({ result: "invalid", acceptAll: false, disposable: false })).toBe(false);
    // catch-all is a verdict: a second service sees the same catch-all
    expect(needsSecondCheck({ result: "valid", acceptAll: true, disposable: false })).toBe(false);
  });
  it("the same verdict gives the same email either way; only the note names who checked", () => {
    for (const v of [{ result: "valid", acceptAll: false, disposable: false }, { result: "invalid", acceptAll: false, disposable: false }, { result: "valid", acceptAll: true, disposable: false }] as const) {
      const a = afterVerify(guess, v), b = afterVerify(guess, v, "InboxTrue");
      expect(b.status).toBe(a.status);
      expect(b.address).toBe(a.address);
    }
    expect(afterVerify(guess, { result: "valid", acceptAll: false, disposable: false }).note).toBe("verified (QuickEmailVerification)");
    expect(afterVerify(guess, { result: "valid", acceptAll: false, disposable: false }, "InboxTrue").note).toBe("verified (InboxTrue)");
  });
});

import { keepSureEmails, isSureEmail } from "./email-apis.js";
describe("only sure addresses go out (no pattern guesses)", () => {
  it("verified and published-for-this-name are sure; likely, guessed, catch-all and invalid are not", () => {
    expect(isSureEmail({ address: "a@b.test", status: "verified", note: "" })).toBe(true);
    expect(isSureEmail({ address: "a@b.test", status: "observed", note: "" })).toBe(true);
    for (const status of ["likely", "guessed", "invalid"] as const) expect(isSureEmail({ address: "a@b.test", status, note: "" })).toBe(false);
    expect(isSureEmail(null)).toBe(false);
  });
  it("strips every unsure address, the main contact and the people under them", () => {
    const person = (name: string, status: "verified" | "likely" | "guessed") => ({ name, role: null, source: "x", email: { address: `${name}@northwind.test`, status, note: "" } });
    const contacts = new Map([
      ["a", { person: person("jo", "likely"), others: [{ persona: "CEO", person: person("max", "verified") }], persona: null, note: "" }],
      ["b", { person: person("ana", "verified"), persona: null, note: "" }],
      ["c", { person: person("lee", "guessed"), persona: null, note: "" }],
      ["d", null],
    ]);
    expect(keepSureEmails(contacts)).toBe(2);
    expect(contacts.get("a")!.person.email).toBeNull();
    expect(contacts.get("a")!.others![0]!.person.email?.status).toBe("verified");
    expect(contacts.get("b")!.person.email?.status).toBe("verified");
    expect(contacts.get("c")!.person.email).toBeNull();
  });
});

import { findSureEmail, candidateAddresses, type WaterfallDeps } from "./email-apis.js";
describe("our own email waterfall", () => {
  const usage = () => { const m = new Map<string, number>(); return { spentToday: async (s: string) => m.get(s) ?? 0, addSpend: async (s: string, n: number) => { m.set(s, (m.get(s) ?? 0) + n); } }; };
  const keys = { qev: true, hunter: true, prospeo: true, inboxtrue: false, apollo: false, web: true };
  const exists = (good: string[], acceptAll = false) => async (a: string) => ({ result: good.includes(a) ? "valid" as const : "invalid" as const, acceptAll, disposable: false });
  const base = (over: Partial<WaterfallDeps> = {}): WaterfallDeps => ({ keys, usage: usage(), monthUsed: async () => 0, web: async () => [], hunter: async () => null, prospeo: async () => null, ...over });
  it("tries the usual formats, learned pattern first, and returns the one a verifier confirms", async () => {
    expect(candidateAddresses("Ravi Sen", "contoso.test", "flast")).toEqual(["rsen@contoso.test", "ravi.sen@contoso.test", "ravi@contoso.test", "ravisen@contoso.test"]);
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, base({ verify: exists(["ravi@contoso.test"]) }));
    expect(r.email).toMatchObject({ address: "ravi@contoso.test", status: "verified" });
    // finders first (they answer verified or nothing), then the free discovery steps the verifiers check
    expect(r.steps).toEqual(["prospeo", "hunter", "web", "formats"]);
  });
  it("a catch-all domain proves nothing: formats stop at once, finders are asked, nothing unsure is called sure", async () => {
    let hunter = 0;
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, base({ verify: exists([], true), hunter: async () => { hunter++; return { address: "ravi.sen@contoso.test", score: 95, verified: false }; } }));
    expect(r.catchAll).toBe(true);
    expect(hunter).toBe(1);
    expect(r.email?.status).not.toBe("verified");
  });
  it("a web page's address counts once verified; a finder's address on another domain is ignored", async () => {
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, base({ web: async () => [{ address: "r.sen@contoso.test", url: "https://dir.example" }], verify: exists(["r.sen@contoso.test"]) }));
    expect(r.email).toMatchObject({ address: "r.sen@contoso.test", status: "verified" });
    const off = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, base({ verify: exists([]), prospeo: async () => ({ address: "ravi@oldjob.test", score: null, verified: true, domain: null }) }));
    expect(off.email?.status).not.toBe("verified");
  });
  it("a bounced address is never tried again, and a finder's verified address is sure", async () => {
    const checked: string[] = [];
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test", current: { address: "ravi.sen@contoso.test", status: "invalid", note: "bounced" } },
      base({ verify: async (a) => { checked.push(a); return { result: "invalid", acceptAll: false, disposable: false }; }, hunter: async () => ({ address: "rs@contoso.test", score: 70, verified: true }) }));
    expect(checked).not.toContain("ravi.sen@contoso.test");
    expect(r.email).toMatchObject({ address: "rs@contoso.test", status: "verified" });
  });
});

describe("the waterfall is smart about checks and credits", () => {
  const usage = () => { const m = new Map<string, number>(); return { m, spentToday: async (s: string) => m.get(s) ?? 0, addSpend: async (s: string, n: number) => { m.set(s, (m.get(s) ?? 0) + n); } }; };
  const keys = { qev: true, hunter: true, prospeo: true, inboxtrue: true, apollo: false, web: true };
  it("a finder's verified address ends it with no verifier call and no later finder", async () => {
    const u = usage(); let checks = 0, hunter = 0;
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, { keys, usage: u, monthUsed: async () => 0,
      prospeo: async () => ({ address: "ravi.sen@contoso.test", score: null, verified: true, domain: "contoso.test" }), hunter: async () => { hunter++; return null; },
      verify: async () => { checks++; return null; }, web: async () => [] });
    expect(r.email).toMatchObject({ address: "ravi.sen@contoso.test", status: "verified" });
    expect([checks, hunter]).toEqual([0, 0]);
    expect(u.m.get("prospeo")).toBe(1);
  });
  it("a miss costs no finder allowance; an unverified finder answer is checked before the web and the formats", async () => {
    const u = usage(); const checked: string[] = [];
    const r = await findSureEmail({ name: "Ravi Sen", domain: "contoso.test" }, { keys, usage: u, monthUsed: async () => 0,
      prospeo: async () => null, hunter: async () => ({ address: "rsen@contoso.test", score: 70, verified: false }),
      verify: async (a) => { checked.push(a); return { result: a === "rsen@contoso.test" ? "valid" : "invalid", acceptAll: false, disposable: false }; }, web: async () => [] });
    expect(r.email).toMatchObject({ address: "rsen@contoso.test", status: "verified" });
    expect(checked).toEqual(["rsen@contoso.test"]);
    expect(u.m.get("prospeo")).toBeUndefined();
    expect(u.m.get("hunter")).toBe(1);
  });
});
