import { describe, it, expect } from "vitest";
import { issueDay, signLabel, labelLinks } from "./label-links.js";
// @ts-expect-error plain JS Worker module
import { sign } from "../../../infra/scheduler/sign.js";

const D = "11111111-2222-4333-8444-555555555555";

describe("label links", () => {
  it("the digest and the Worker sign identically (the issue day is inside the signature)", async () => {
    for (const v of ["good", "bad"] as const) expect(signLabel("s3cret", D, v, 20780)).toBe(await sign("s3cret", D, `${v}|20780`));
  });
  it("builds both links on the Worker URL, with the day they were issued", () => {
    const l = labelLinks("https://w.test/", "s3cret", D), t = issueDay();
    expect(l.good).toBe(`https://w.test/l?d=${D}&v=good&t=${t}&s=${signLabel("s3cret", D, "good", t)}`);
    expect(l.bad).toContain("v=bad");
  });
});
