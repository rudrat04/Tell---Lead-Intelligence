import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { domainLists } from "@tell/people";
import { allowedRequests, pickRotating, employerDomain, groupEmployers } from "./discover-jsearch.js";

const pack = await loadFixturePack();
const lists = domainLists(pack.domains);
const now = new Date("2026-11-14T06:00:00Z");
const cls = { family: "core" as const, contract: false, founding: false };
const hit = (o: Partial<{ jobId: string; title: string; employer: string; website: string | null; applyLink: string }>) => ({
  jobId: "1", title: "RevOps Manager", employer: "Acme Analytics", website: null, applyLink: "https://www.linkedin.com/jobs/view/1",
  publisher: null, location: "Pune, IN", countryCodes: ["IN"], cls, ...o,
});

describe("JSearch discovery", () => {
  it("rotates distinct queries across days", () => {
    const qs = ["a", "b", "c", "d", "e"];
    const today = pickRotating(qs, 2, now);
    expect(new Set(today).size).toBe(2);
    expect(pickRotating(qs, 2, new Date(now.getTime() + 86_400_000))).not.toEqual(today);
    expect(pickRotating(qs, 9, now).sort()).toEqual(qs);
    expect(pickRotating(qs, 0, now)).toEqual([]);
  });
  it("paces a small monthly quota across the month", () => {
    // 12 a month: one search every 2-3 days, never more than per_run, never past the quota
    const run = (perMonth: number, perRun: number) => {
      let used = 0; const days: number[] = [];
      for (let d = 1; d <= 30; d++) { const n = allowedRequests(perRun, perMonth, used, `2026-11-${String(d).padStart(2, "0")}`); if (n) days.push(d); used += n; }
      return { used, days };
    };
    const small = run(12, 6);
    expect(small.used).toBe(12);
    expect(small.days[0]).toBeGreaterThan(1);
    expect(small.days.at(-1)).toBe(30);
    const big = run(180, 6);
    expect(big.used).toBe(180);
    expect(allowedRequests(6, 12, 12, "2026-11-30")).toBe(0);
  });
  it("employer domain: JSearch website or the apply link's own site, only when it matches the name", () => {
    expect(employerDomain(hit({ website: "https://www.acmeanalytics.in" }), lists)).toBe("acmeanalytics.in");
    expect(employerDomain(hit({ applyLink: "https://careers.acmeanalytics.com/jobs/9" }), lists)).toBe("acmeanalytics.com");
    // job sites and ATS hosts never become the company
    expect(employerDomain(hit({ applyLink: "https://www.naukri.com/job-listings-1" }), lists)).toBeNull();
    expect(employerDomain(hit({ employer: "Keka", applyLink: "https://acme.keka.com/careers/jobdetails/1" }), lists)).toBeNull();
    // a site that doesn't match the employer's name is not guessed
    expect(employerDomain(hit({ website: "https://somethingelse.com" }), lists)).toBeNull();
  });
  it("groups by employer and keeps one listing per title (same role on several publishers)", () => {
    const g = groupEmployers([
      hit({ jobId: "1" }), hit({ jobId: "2", title: "revops manager" }), hit({ jobId: "3", title: "Head of Sales Ops" }),
      hit({ jobId: "4", employer: "acme  analytics" }), hit({ jobId: "5", employer: "Other Co" }),
    ]);
    expect(g).toHaveLength(2);
    expect(g.find((e) => e.key === "acme analytics")!.hits.map((h) => h.jobId)).toEqual(["1", "3"]);
  });
});
