import { describe, it, expect } from "vitest";
import { inScope, type Pack } from "@tell/config";
import { oppInScope } from "./opportunities.js";

const US = "United States of America";
const pack = (regions: string[]) => ({
  meta: { regions },
  opportunities: { rosters: {
    federal: { kind: "usaspending_awardees" },
    in_machinery: { kind: "company_search", regions: ["India"] },
    us_staffing: { kind: "company_search", regions: [US] },
  } },
}) as unknown as Pack;

describe("working regions (pack.yaml regions)", () => {
  it("an empty scope is everywhere; a place nobody knows stays in", () => {
    expect(inScope([], [US])).toBe(true);
    expect(inScope(["India"], [null])).toBe(true);
    expect(inScope(["India"], [US])).toBe(false);
    expect(inScope(["India"], ["India", US])).toBe(true);
  });
  it("India only pauses federal recompetes and US rosters and news, keeps India ones", () => {
    const p = pack(["India"]);
    expect(oppInScope({ kind: "usaspending_expiring", roster: "federal" } as never, p)).toBe(false);
    expect(oppInScope({ kind: "news", roster: "us_staffing", region: US, beneficiary_regions: [] } as never, p)).toBe(false);
    expect(oppInScope({ kind: "news", roster: "in_machinery", region: "India", beneficiary_regions: [] } as never, p)).toBe(true);
    expect(oppInScope({ kind: "signals", roster: "in_machinery", beneficiary_regions: ["India"] } as never, p)).toBe(true);
    expect(oppInScope({ kind: "usaspending_expiring", roster: "federal" } as never, pack([]))).toBe(true);
  });
});
