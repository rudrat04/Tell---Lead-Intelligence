import { describe, it, expect } from "vitest";
import { postedDate } from "./types.js";

describe("postedDate: placeholder dates are no date", () => {
  const now = new Date(Date.UTC(2026, 10, 14));
  it("keeps a real date", () => expect(postedDate("2026-10-01T00:00:00Z", now)?.toISOString()).toBe("2026-10-01T00:00:00.000Z"));
  it("drops .NET's DateTime.MinValue (Keka's 'no date')", () => expect(postedDate("0001-01-01T00:00:00", now)).toBeUndefined());
  it("drops epoch, future, empty and garbage", () => {
    for (const v of [0, "1970-01-01T00:00:00Z", "2027-06-01T00:00:00Z", "", null, undefined, "not a date"]) expect(postedDate(v, now)).toBeUndefined();
  });
});
