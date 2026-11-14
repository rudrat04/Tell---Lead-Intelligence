import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import { regionInScope } from "./icp.js";

const pack = await loadFixturePack();
const icp = (regions: string[]) => ({ ...pack.icp, hard_filters: { ...pack.icp.hard_filters, regions_any: regions } });

describe("regionInScope: boards and the watch skip accounts scoring can never use", () => {
  it("with regions_any, only a known region on the list", () => {
    expect(regionInScope("India", icp(["India"]))).toBe(true);
    expect(regionInScope("United States of America", icp(["India"]))).toBe(false);
    expect(regionInScope(null, icp(["India"]))).toBe(false); // scoring drops unknown regions too
  });
  it("without regions_any, everything", () => {
    expect(regionInScope(null, icp([]))).toBe(true);
    expect(regionInScope("Germany", icp([]))).toBe(true);
  });
});
