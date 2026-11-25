import { describe, it, expect } from "vitest";
import { parseDiscover, parseEnrich, type WaterfallEmail } from "@tell/watchers";
import { enrichStatus, waterfallSure } from "./waterfall.js";

const r = (verdict: WaterfallEmail["verdict"], email: string | null, extra: Partial<WaterfallEmail> = {}): WaterfallEmail =>
  ({ email, verdict, confidence: 0.9, catchAll: false, foundAt: "tomba", cached: false, credits: 1, ...extra });

describe("Air Waterfall responses", () => {
  it("parses people and skips rows without a first name", () => {
    expect(parseDiscover({ people: [
      { id: 1, first_name: "Mila", last_name: "Osk", title: "Head of Growth", source: "serper", source_url: "https://linkedin.example/in/mila", name_shared: false },
      { id: 2, first_name: "", last_name: "X", title: "CEO", source: "site", source_url: null, name_shared: false },
    ] })).toEqual([{ firstName: "Mila", lastName: "Osk", title: "Head of Growth", source: "serper", sourceUrl: "https://linkedin.example/in/mila", nameShared: false }]);
    expect(parseDiscover({ error: "rate limit exceeded" })).toEqual([]);
  });

  it("parses an enrich result; an unknown verdict or a missing address is not_found", () => {
    expect(parseEnrich({ email: "Mila@Acme.test", verdict: "valid", confidence: 0.92, catch_all: false, found_at: "pattern", cached: true, cost: { credits: 2 } }))
      .toEqual({ email: "mila@acme.test", verdict: "valid", confidence: 0.92, catchAll: false, foundAt: "pattern", cached: true, credits: 2 });
    expect(parseEnrich({ email: null, verdict: "likely" }).verdict).toBe("not_found");
    expect(parseEnrich({ email: "a@b.test", verdict: "great" }).verdict).toBe("not_found");
  });
});

describe("Enrich email cell", () => {
  it("is a short status after the click (the address goes in Email); suppressed never shows anything", () => {
    expect(enrichStatus(r("valid", "mila@acme.test"))).toBe("done: verified (tomba)");
    // a guess is never "done": the Email cell stays empty
    expect(enrichStatus(r("risky", "mila@acme.test", { confidence: 0.4, foundAt: null }))).toBe("no verified address (risky)");
    expect(enrichStatus(r("likely", "mila@acme.test"))).toBe("no verified address (likely)");
    expect(enrichStatus(r("valid", "mila@acme.test", { catchAll: true }))).toBe("no verified address (catch-all domain)");
    // our own verifier confirmed what Air Waterfall only guessed
    expect(enrichStatus(r("risky", "mila@acme.test"), false, { address: "mila@acme.test", status: "verified", note: "verified (QuickEmailVerification)" })).toBe("done: verified (QuickEmailVerification)");
    expect(enrichStatus(r("invalid", null))).toBe("no deliverable address");
    expect(enrichStatus(r("not_found", null))).toBe("not found");
    expect(enrichStatus(r("valid", "mila@acme.test"), true)).toBe("suppressed (do not contact)");
  });
});

describe("Air Waterfall answers that count as sure", () => {
  it("only valid on a domain that is not catch-all; risky and likely are guesses", () => {
    expect(waterfallSure(r("valid", "mila@acme.test"))).toBe(true);
    expect(waterfallSure(r("valid", "mila@acme.test", { catchAll: null }))).toBe(true);
    expect(waterfallSure(r("valid", "mila@acme.test", { catchAll: true }))).toBe(false);
    expect(waterfallSure(r("risky", "mila@acme.test"))).toBe(false);
    expect(waterfallSure(r("likely", "mila@acme.test"))).toBe(false);
    expect(waterfallSure(r("not_found", null))).toBe(false);
  });
});
