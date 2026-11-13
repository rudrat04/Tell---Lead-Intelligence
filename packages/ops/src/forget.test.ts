import { describe, it, expect } from "vitest";
import { hashEmail, scrubRow } from "./forget.js";

describe("forget helpers", () => {
  it("hashes emails case-insensitively (suppression keeps no address)", () => {
    expect(hashEmail(" Jane@Acme.com ")).toBe(hashEmail("jane@acme.com"));
    expect(hashEmail("jane@acme.com")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("scrubs a name from every cell of a stored Sheet row", () => {
    expect(scrubRow(["2026-11-13", "Riya Sample", "CEO", "Hi Riya Sample, saw..."], "Riya Sample")).toEqual(["2026-11-13", "[removed]", "CEO", "Hi [removed], saw..."]);
    expect(scrubRow(null, "x")).toBeNull();
  });
});
