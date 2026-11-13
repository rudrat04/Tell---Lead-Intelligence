import { describe, it, expect } from "vitest";
import { signLabel, labelLinks } from "./label-links.js";
// @ts-expect-error plain JS Worker module
import { sign } from "../../../infra/scheduler/sign.js";

const D = "11111111-2222-4333-8444-555555555555";

describe("label links", () => {
  it("the digest and the Worker sign identically", async () => {
    for (const v of ["good", "bad"] as const) expect(signLabel("s3cret", D, v)).toBe(await sign("s3cret", D, v));
  });
  it("builds both links on the Worker URL", () => {
    const l = labelLinks("https://w.test/", "s3cret", D);
    expect(l.good).toBe(`https://w.test/l?d=${D}&v=good&s=${signLabel("s3cret", D, "good")}`);
    expect(l.bad).toContain("v=bad");
  });
});
