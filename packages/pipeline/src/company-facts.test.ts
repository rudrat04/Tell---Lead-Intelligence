import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { parseExaCompanies } from "@tell/watchers";
import { bandForHeadcount, companyFor, parseSegment, segmentPrompt, profileLine } from "./company-facts.js";

describe("company facts", async () => {
  const base = await loadFixturePack();
  const pack = { ...base, icp: { ...base.icp, hard_filters: { ...base.icp.hard_filters, team_size: { min: 5, max: 150 } },
    segment_descriptions: { b2b: "sells to businesses", d2c: "sells to consumers" } } };

  it("headcount -> the pack's band; under the minimum or over the last band is a band the pack doesn't have", () => {
    expect(bandForHeadcount(8, pack.icp)).toBe("2-10");
    expect(bandForHeadcount(120, pack.icp)).toBe("51-150");
    expect(bandForHeadcount(3, pack.icp)).toBe("under 5");
    expect(bandForHeadcount(900, pack.icp)).toBe("151+");
  });

  it("only a result on the account's own domain counts (never a name match)", () => {
    const hits = parseExaCompanies({ results: [
      { url: "https://www.northwind-group.test/", title: "Northwind", entities: [{ type: "company", properties: { name: "Northwind", workforce: { total: 4000 }, description: "x" } }] },
      { url: "https://northwind.test/about", title: "Northwind", entities: [{ type: "company", properties: { name: "Northwind", workforce: { total: 40 }, description: "B2B billing software", headquarters: { country: "India" } } }] },
      { url: "https://nothing.test/", title: "No entity" },
    ] });
    expect(hits).toHaveLength(2);
    expect(companyFor("northwind.test", hits)).toMatchObject({ employees: 40, country: "India" });
    expect(companyFor("other.test", hits)).toBeNull();
    const li = parseExaCompanies({ results: [
      { url: "https://in.linkedin.com/company/tinyloop", entities: [{ type: "company", properties: { name: "TinyLoop", workforce: { total: 30 } } }] },
      { url: "https://www.linkedin.com/company/tinyloop-labs", entities: [{ type: "company", properties: { name: "Tinyloop Labs", workforce: { total: 900 } } }] },
    ] });
    expect(companyFor("tinyloop.test", li)?.employees).toBe(30); // LinkedIn page: address and name both match the domain
    expect(companyFor("tinyloop.test", [li[1]!])).toBeNull(); // a similar name alone is not proof
    expect(companyFor("loop.test", li, "TinyLoop")).toBeNull(); // the address must match the domain too
  });

  it("segment answer must be one of the pack's segments", () => {
    expect(segmentPrompt(pack)).toContain("- b2b: sells to businesses");
    expect(parseSegment(" B2B\n", pack)).toBe("b2b");
    expect(parseSegment("d2c.", pack)).toBe("d2c");
    expect(parseSegment("enterprise", pack)).toBeNull();
  });
  it("what they do: a short description stays whole; a long one is cut at a sentence end", () => {
    expect(profileLine("  Northwind makes generic injectables\nfor US hospitals.  ")).toBe("Northwind makes generic injectables for US hospitals.");
    const long = `Northwind makes generic injectables for hospitals across the US and Europe. ${"It also runs a contract manufacturing arm for oncology drugs with three plants. ".repeat(4)}`;
    const cut = profileLine(long);
    expect(cut.length).toBeLessThanOrEqual(240);
    expect(cut.endsWith(".")).toBe(true);
    expect(profileLine("x".repeat(300) + " y")).toMatch(/…$/);
  });
});
