import { describe, it, expect } from "vitest";
import { parseRobots, isPathAllowed } from "./robots.js";

describe("robots.txt", () => {
  const txt = `
User-agent: *
Disallow: /admin
Allow: /admin/public
Disallow: /*.pdf$

User-agent: BadBot
Disallow: /
`;
  const rules = parseRobots(txt);
  it("longest match wins", () => {
    expect(isPathAllowed(rules, "/careers")).toBe(true);
    expect(isPathAllowed(rules, "/admin/x")).toBe(false);
    expect(isPathAllowed(rules, "/admin/public/x")).toBe(true);
  });
  it("wildcards and end anchors", () => {
    expect(isPathAllowed(rules, "/files/a.pdf")).toBe(false);
    expect(isPathAllowed(rules, "/files/a.pdf?x=1")).toBe(true);
  });
  it("a group naming our bot overrides *", () => {
    const r = parseRobots("User-agent: *\nAllow: /\n\nUser-agent: TellLeadIntelligence\nDisallow: /");
    expect(isPathAllowed(r, "/careers")).toBe(false);
  });
  it("empty Disallow allows everything", () => {
    expect(isPathAllowed(parseRobots("User-agent: *\nDisallow:"), "/x")).toBe(true);
  });
});

import { robotsMatch } from "./robots.js";
describe("robots.txt wildcards never backtrack", () => {
  it("matches like the regex version did", () => {
    expect(robotsMatch("/careers", "/careers/jobs")).toBe(true);     // prefix
    expect(robotsMatch("/careers$", "/careers/jobs")).toBe(false);   // anchored
    expect(robotsMatch("/careers$", "/careers")).toBe(true);
    expect(robotsMatch("/*.pdf$", "/files/a.pdf")).toBe(true);
    expect(robotsMatch("/*.pdf$", "/files/a.pdf?x=1")).toBe(false);
    expect(robotsMatch("/O.*Z", "/O.abcZ")).toBe(true);                // a literal dot stays literal
    expect(robotsMatch("/O.*Z", "/OxabcZ")).toBe(false);
    expect(robotsMatch("/maps/*", "/maps/radar")).toBe(true);
  });
  it("a pattern of 88 stars (seen on a real site) answers instantly", () => {
    const pattern = `${"*".repeat(88)}/alerts$`;
    const t = Date.now();
    expect(robotsMatch(pattern, "/careers")).toBe(false);
    expect(robotsMatch(pattern, "/us/fl/miami/alerts")).toBe(true);
    expect(isPathAllowed([{ allow: false, pattern: "/" }, { allow: true, pattern }], "/careers")).toBe(false);
    expect(Date.now() - t).toBeLessThan(50);
  });
});
