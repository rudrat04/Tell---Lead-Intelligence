import type { Pack } from "@tell/config";
import type { Evidence } from "./rank.js";

/**
 * Is this a good time to message? A label shown next to a lead, never part of priority, ranking or the fast lane:
 * the score says who needs you, this says when to write. Built from two things:
 *   - the lead's own signals: an ask or contract role in the last few weeks, a role open so long that hiring is
 *     stalling, a leader in their first 90 days, money just raised, a launch, a role just filled (against);
 *   - the buyer's calendar (pack icp.calendar): the start of a quarter and of the financial year (fresh budgets), the
 *     last two months of the financial year (next year's budget is being planned), the last days of a quarter (teams
 *     are closing deals), and quiet periods you list (holidays; festival dates move every year, so they live in the pack).
 * Pure: `now` is passed in.
 */
export type SendBand = "now" | "good" | "wait";
export interface SendWindow { band: SendBand; label: string; reasons: string[] }

export const SEND_LABEL: Record<SendBand, string> = { now: "Message now", good: "Good time", wait: "Can wait" };

type Calendar = Pack["icp"]["calendar"];

/** Signal points: [points, reason] for the strongest reading of each signal type that applies. */
function signalPoints(evidence: Evidence[]): [number, string][] {
  const out: [number, string][] = [];
  const best = (types: string[]) => evidence.filter((e) => types.includes(e.type)).sort((a, b) => a.ageDays - b.ageDays)[0];
  const ask = best(["explicit_hire_request", "contract_role", "freeze_to_contract", "champion_moved", "pain_post"]);
  if (ask && ask.ageDays <= 14) out.push([3, ask.type === "pain_post" ? `posted about the problem ${ask.ageDays}d ago` : `asked for outside help ${ask.ageDays}d ago`]);
  else if (ask && ask.ageDays <= 30) out.push([2, `asked for outside help ${ask.ageDays}d ago`]);
  const stalled = evidence.find((e) => e.type === "core_role_open_45d" && e.current);
  if (stalled) out.push([2, `role open ${stalled.openDays ?? 45}+ days: hiring is stalling`]);
  else {
    const fresh = evidence.find((e) => (e.type === "core_role_open" || e.type === "first_role") && e.current && (e.openDays ?? e.ageDays) <= 14);
    if (fresh) out.push([1, "new role: they are scoping the work now"]);
  }
  const leader = best(["new_gtm_leader"]);
  if (leader && leader.ageDays >= 14 && leader.ageDays <= 90) out.push([2, "new leader in their first 90 days"]);
  else if (leader && leader.ageDays < 14) out.push([1, "new leader just joined (give them a week or two)"]);
  const raise = best(["funding_raise"]);
  if (raise && raise.ageDays <= 60) out.push([2, `raised ${raise.ageDays}d ago`]);
  else if (raise && raise.ageDays <= 120) out.push([1, `raised ${raise.ageDays}d ago`]);
  const launch = best(["product_launch"]);
  if (launch && launch.ageDays <= 30) out.push([1, `launched ${launch.ageDays}d ago`]);
  const filled = best(["core_role_filled"]);
  if (filled && filled.ageDays <= 30) out.push([-2, `filled the role ${filled.ageDays}d ago`]);
  return out;
}

/** Calendar points for `now` in the buyer's financial year. */
export function calendarPoints(now: Date, cal: Calendar): [number, string][] {
  const out: [number, string][] = [];
  const m = now.getUTCMonth() + 1, d = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), m, 0)).getUTCDate();
  const fy = cal.fiscal_year_start_month;
  const monthInYear = (m - fy + 12) % 12;            // 0 = first month of the financial year
  const monthInQuarter = monthInYear % 3;
  const lastDays = d > daysInMonth - cal.quarter_end_days;
  if (monthInYear === 0 && d <= 21) out.push([2, "new financial year: budgets just released"]);
  else if (monthInQuarter === 0 && d <= 21) out.push([1, "start of a quarter: fresh quarterly budget"]);
  if (monthInYear >= 10 && !(monthInYear === 11 && lastDays)) out.push([1, "next year's budget is being planned"]);
  if (monthInQuarter === 2 && lastDays) out.push([-1, monthInYear === 11 ? "financial year close: teams are busy closing" : "quarter close: teams are busy closing deals"]);
  const md = m * 100 + d;
  for (const q of cal.quiet_periods) {
    const [fm, fd] = q.from.split("-").map(Number), [tm, td] = q.to.split("-").map(Number);
    const from = fm! * 100 + fd!, to = tm! * 100 + td!;
    if (from <= to ? md >= from && md <= to : md >= from || md <= to) out.push([-1, q.reason]);
  }
  return out;
}

export function sendWindow(evidence: Evidence[], now: Date, cal: Calendar): SendWindow {
  const sig = signalPoints(evidence.filter((e) => e.class !== "negative" || e.type === "core_role_filled"));
  const calPts = calendarPoints(now, cal);
  const total = Math.min(4, sig.reduce((a, [p]) => a + p, 0)) + calPts.reduce((a, [p]) => a + p, 0);
  const band: SendBand = total >= 3 ? "now" : total >= 1 ? "good" : "wait";
  // reasons: what moved it most first (signals before calendar on ties); "against" reasons count too
  const reasons = [...sig, ...calPts].sort((a, b) => Math.abs(b[0]) - Math.abs(a[0])).map(([p, r]) => (p < 0 ? `but ${r}` : r));
  // every label says why, even when nothing moved it
  if (!reasons.length) reasons.push(band === "wait" ? "no fresh trigger (no recent ask, stalled role, new leader, raise or launch) and nothing on the calendar" : "no strong trigger either way");
  return { band, label: SEND_LABEL[band], reasons: reasons.slice(0, 3) };
}

/** "Message now: role open 52+ days: hiring is stalling; start of a quarter: fresh quarterly budget" */
export const sendWindowText = (w: SendWindow) => (w.reasons.length ? `${w.label}: ${w.reasons.join("; ")}` : w.label);
