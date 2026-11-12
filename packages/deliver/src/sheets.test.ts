import { describe, it, expect } from "vitest";
import { parseLabels, LEAD_COLUMNS } from "./sheets.js";

const ID1 = "11111111-1111-4111-8111-111111111111";
const ID2 = "22222222-2222-4222-8222-222222222222";

describe("parseLabels", () => {
  it("reads labelled rows by header name, even if you reorder or add columns", () => {
    const header = ["Notes", "My column", ...LEAD_COLUMNS.filter((c) => c !== "Notes")];
    const row = (id: string, label: string, reason = "", outcome = "") => header.map((h) => ({ ID: id, Label: label, Reason: reason, Outcome: outcome, Notes: label ? "called" : "" } as Record<string, string>)[h] ?? "x");
    const out = parseLabels([header, row(ID1, "Good", "", "Replied"), row(ID2, "")]);
    expect(out).toEqual([{ id: ID1, label: "good", reason: null, outcome: "replied", notes: "called" }]);
  });
  it("ignores rows without a valid ID (e.g. rows you added by hand)", () => {
    expect(parseLabels([[...LEAD_COLUMNS], LEAD_COLUMNS.map((c) => (c === "Label" ? "bad" : c === "ID" ? "my own row" : ""))])).toEqual([]);
  });
});
