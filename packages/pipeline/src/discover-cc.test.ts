import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { domainLists } from "@tell/people";
import { siteCandidates } from "./discover-cc.js";

const lists = domainLists((await loadFixturePack()).domains);

describe("site candidates for an ATS tenant (checked for a backlink, never accepted on their own)", () => {
  it("portal links that match the name come first, then slug and name variants", () => {
    const c = siteCandidates("acmepay-careers", "Acme Pay", ["https://www.linkedin.com/company/acmepay", "https://acmepay.example/"], lists);
    expect(c[0]).toBe("acmepay.example");
    expect(c).toContain("acmepay.com");
    expect(c).toContain("acmepay.in");
    expect(c).not.toContain("linkedin.com");
  });
  it("a name that is a domain is tried", () => {
    expect(siteCandidates("zetaos", "Zeta.ai", [], lists)).toContain("zeta.ai");
  });
  it("is bounded", () => {
    expect(siteCandidates("acme-labs", "Acme Labs Private Limited", [], lists, 5)).toHaveLength(5);
  });
});
