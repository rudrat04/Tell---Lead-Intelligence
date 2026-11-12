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
