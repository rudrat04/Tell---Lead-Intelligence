import { describe, it, expect } from "vitest";
import { afterVerify, fromFinder } from "./email-apis.js";

const guess = { address: "asha@northwind.test", status: "likely" as const, note: "first@ pattern" };
describe("email upgrades", () => {
  it("verification: valid = verified; catch-all stays likely with a note; invalid or disposable = invalid; unknown changes nothing", () => {
    expect(afterVerify(guess, { result: "valid", acceptAll: false, disposable: false }).status).toBe("verified");
    expect(afterVerify(guess, { result: "valid", acceptAll: true, disposable: false })).toMatchObject({ status: "likely", note: "first@ pattern · catch-all domain (accepts any address)" });
    expect(afterVerify(guess, { result: "invalid", acceptAll: false, disposable: false }).status).toBe("invalid");
    expect(afterVerify(guess, { result: "unknown", acceptAll: false, disposable: false })).toEqual(guess);
  });
  it("a finder's address is verified only when it says so or scores 80+", () => {
    expect(fromFinder({ address: "a@b.test", score: 91, verified: false }, "Hunter")?.status).toBe("verified");
    expect(fromFinder({ address: "a@b.test", score: 50, verified: false }, "Hunter")).toEqual({ address: "a@b.test", status: "likely", note: "found by Hunter (score 50)" });
    expect(fromFinder(null, "Prospeo")).toBeNull();
  });
});
