import { describe, expect, it } from "vitest";
import { sendWindow, calendarPoints, sendWindowText } from "./send-window.js";
import type { Evidence } from "./rank.js";

const india = { fiscal_year_start_month: 4, quarter_end_days: 10, quiet_periods: [{ from: "12-22", to: "01-02", reason: "year-end holidays" }] };
const ev = (type: string, ageDays: number, extra: Partial<Evidence> = {}): Evidence => ({
  type, class: type === "core_role_filled" ? "negative" : "implicit", ageDays, current: false, quote: type, url: "https://example.invalid", ref: { kind: "signal", id: type }, ...extra,
});
const day = (s: string) => new Date(`${s}T12:00:00Z`);

describe("good time to message (separate from the score)", () => {
  it("a fresh ask in a neutral week is 'Message now'", () => {
    const w = sendWindow([ev("contract_role", 3, { current: true })], day("2026-11-16"), india);
    expect(w.band).toBe("now");
    expect(w.reasons[0]).toContain("asked for outside help 3d ago");
  });

  it("a stale adjacent role and nothing else can wait, and the label still says why", () => {
    const w = sendWindow([ev("adjacent_role_open", 40, { current: true })], day("2026-11-16"), india);
    expect(w.band).toBe("wait");
    expect(sendWindowText(w)).toMatch(/^Can wait: no fresh trigger/);
  });

  it("the Indian financial year: April budgets are fresh, late March is closing, Feb is planning", () => {
    expect(calendarPoints(day("2026-04-06"), india).map(([p]) => p)).toEqual([2]);
    expect(calendarPoints(day("2026-03-27"), india)).toEqual([[-1, "financial year close: teams are busy closing"]]);
    expect(calendarPoints(day("2026-02-10"), india)).toEqual([[1, "next year's budget is being planned"]]);
    expect(calendarPoints(day("2026-06-25"), india)).toEqual([[-1, "quarter close: teams are busy closing deals"]]);
    expect(calendarPoints(day("2026-07-08"), india)).toEqual([[1, "start of a quarter: fresh quarterly budget"]]);
    expect(calendarPoints(day("2026-11-16"), india)).toEqual([]);
  });

  it("quiet periods wrap the year end", () => {
    expect(calendarPoints(day("2026-12-30"), india).some(([, r]) => r === "year-end holidays")).toBe(true);
    expect(calendarPoints(day("2027-01-01"), india).some(([, r]) => r === "year-end holidays")).toBe(true);
    expect(calendarPoints(day("2027-01-05"), india).some(([, r]) => r === "year-end holidays")).toBe(false);
  });

  it("a new leader in their first 90 days plus a fresh quarter is 'Message now'; a role just filled holds it back", () => {
    expect(sendWindow([ev("new_gtm_leader", 30)], day("2026-07-06"), india).band).toBe("now");
    const w = sendWindow([ev("core_role_open_45d", 0, { current: true, openDays: 60 }), ev("core_role_filled", 5)], day("2026-11-16"), india);
    expect(w.band).toBe("wait");
    expect(sendWindowText(w)).toContain("but filled the role 5d ago");
  });

  it("signals are capped, so the calendar still moves the band", () => {
    const many = [ev("contract_role", 2), ev("funding_raise", 10), ev("new_gtm_leader", 30), ev("product_launch", 5)];
    expect(sendWindow(many, day("2026-12-28"), india).band).toBe("good"); // signals capped at 4, minus quarter close and holidays = 2
  });
});
