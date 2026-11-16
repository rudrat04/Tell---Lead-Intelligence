import { describe, it, expect } from "vitest";
import { parseDiscover, parseEnrich, type WaterfallEmail } from "@tell/watchers";
import { enrichCellText } from "./waterfall.js";

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
  it("says how sure the answer is; a risky guess is labelled as one; suppressed never shows the address", () => {
    expect(enrichCellText(r("valid", "mila@acme.test"))).toBe("mila@acme.test (verified, tomba)");
    expect(enrichCellText(r("likely", "mila@acme.test", { confidence: 0.7, catchAll: true }))).toBe("mila@acme.test (likely 70%, catch-all)");
    expect(enrichCellText(r("risky", "mila@acme.test", { confidence: 0.4 }))).toBe("mila@acme.test (risky guess 40%: verify before sending)");
    expect(enrichCellText(r("invalid", null))).toBe("no deliverable address");
    expect(enrichCellText(r("not_found", null))).toBe("not found");
    expect(enrichCellText(r("valid", "mila@acme.test"), true)).toBe("suppressed (do not contact)");
  });
});
