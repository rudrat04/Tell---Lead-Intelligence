import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { classifyJob as classify, compileRoles, diffBoard, type OpenJobRow, type FetchedJob } from "./jobs.js";
import { passesHardFilters, sizeBand } from "./icp.js";

const pack = await loadFixturePack();
const roles = compileRoles(pack.roles);
const classifyJob = (t: string, type?: string) => classify(t, type, roles);

const DAY = 86_400_000;
const now = new Date(Date.UTC(2026, 10, 12));
const ago = (d: number) => new Date(now.getTime() - d * DAY);

describe("classifyJob", () => {
  it.each([
    ["RevOps Manager", "core"],
    ["Revenue Operations Lead", "core"],
    ["GTM Engineer", "core"],
    ["Salesforce Administrator", "core"],
    ["Founding Account Executive", "adjacent"],
    ["SDR", "adjacent"],
    ["Head of Growth", "adjacent"],
    ["Product Marketing Manager", "adjacent"],
  ])("%s -> %s", (title, family) => expect(classifyJob(title)?.family).toBe(family));
  it.each(["Senior Software Engineer", "Sales Engineer", "Solutions Engineer", "Data Engineer", "Office Manager", "AI GTM Engineer Intern", "RevOps Internship"])("%s -> not a GTM role", (t) =>
    expect(classifyJob(t)).toBeNull());
  it("intern employment type is excluded", () => expect(classifyJob("GTM Engineer", "Intern")).toBeNull());
  it("contract and founding flags", () => {
    expect(classifyJob("RevOps Consultant (Contract)")).toMatchObject({ contract: true });
    expect(classifyJob("Marketing Ops Manager", "Part-time")).toMatchObject({ contract: true });
    expect(classifyJob("Founding Account Executive")).toMatchObject({ founding: true, contract: false });
  });
});

const fj = (id: string, title: string, posted?: number, type?: string): FetchedJob =>
  ({ externalId: id, title, url: `https://jobs.example/${id}`, employmentType: type, postedAt: posted == null ? undefined : ago(posted), cls: classifyJob(title, type)! });
const row = (id: string, title: string, posted: number | null, firstSeen: number): OpenJobRow =>
  ({ id: `row-${id}`, externalId: id, title, url: `https://jobs.example/${id}`, family: classifyJob(title)!.family, postedAt: posted == null ? null : ago(posted), firstSeenAt: ago(firstSeen) });

describe("diffBoard", () => {
  it("baseline: records roles, emits no 'new role' signals", () => {
    const d = diffBoard([], [fj("1", "Founding Account Executive", 10), fj("2", "RevOps Manager", 5)], now, false);
    expect(d.insert).toHaveLength(2);
    expect(d.signals).toEqual([]);
  });
  it("baseline still flags an ops role that the board says is 45+ days old", () => {
    const d = diffBoard([], [fj("1", "RevOps Manager", 60)], now, false);
    expect(d.signals.map((s) => s.type)).toEqual(["core_role_open_45d"]);
  });
  it("after baseline: one signal per new role, most specific type wins", () => {
    const d = diffBoard([], [fj("1", "RevOps Consultant", 1, "Contract"), fj("2", "Founding Account Executive", 1), fj("3", "Marketing Ops Manager", 1), fj("4", "SDR", 1)], now, true);
    expect(d.signals.map((s) => s.type)).toEqual(["contract_role", "first_role", "core_role_open", "adjacent_role_open"]);
  });
  it("roles still open are touched, not re-signalled", () => {
    const d = diffBoard([row("1", "SDR", 3, 3)], [fj("1", "SDR", 3)], now, true);
    expect(d).toMatchObject({ insert: [], touch: ["row-1"], close: [], signals: [] });
  });
  it("ops role open 45+ days by first-seen date only counts after baseline", () => {
    expect(diffBoard([row("1", "RevOps Manager", null, 50)], [fj("1", "RevOps Manager")], now, true).signals.map((s) => s.type)).toEqual(["core_role_open_45d"]);
    expect(diffBoard([row("1", "RevOps Manager", null, 50)], [fj("1", "RevOps Manager")], now, false).signals).toEqual([]);
  });
  it("ops role removed within 30 days of posting -> filled (negative); older or undated -> just closed", () => {
    const d = diffBoard([row("1", "RevOps Manager", 20, 20), row("2", "RevOps Lead", 90, 90), row("3", "Sales Ops Manager", null, 5)], [fj("9", "SDR", 1)], now, true);
    expect(d.close).toEqual(["row-1", "row-2", "row-3"]);
    expect(d.signals.filter((s) => s.type === "core_role_filled").map((s) => s.url)).toEqual(["https://jobs.example/1"]);
  });
  it("an empty fetch with several open roles is suspect: nothing closed", () => {
    const d = diffBoard([row("1", "SDR", 3, 3), row("2", "SDR II", 3, 3), row("3", "RevOps Manager", 3, 3)], [], now, true);
    expect(d).toMatchObject({ suspect: true, close: [], signals: [] });
  });
});

describe("ICP hard filters", () => {
  const icp = pack.icp;
  const base = { domain: "acme.com", teamSize: 12, industries: ["B2B"], status: "Active" };
  it("passes a small active B2B company", () => expect(passesHardFilters(base, icp).pass).toBe(true));
  it.each([
    [{ teamSize: 400 }, "team size 400"],
    [{ teamSize: null }, "team size unknown"],
    [{ industries: ["Consumer"] }, "industry"],
    [{ status: "Inactive" }, "status Inactive"],
    [{ domain: null }, "no domain"],
  ])("rejects %o", (patch, reason) => expect(passesHardFilters({ ...base, ...patch }, icp)).toEqual({ pass: false, reason }));
  it("size bands", () => {
    expect(sizeBand(8, icp)).toBe("2-10");
    expect(sizeBand(40, icp)).toBe("11-50");
    expect(sizeBand(120, icp)).toBe("51-150");
  });
});
