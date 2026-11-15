import { describe, it, expect } from "vitest";
import { warmPaths, championMove, parseLinkedInConnections, parseClients, type NetworkRow } from "./network.js";

const net: NetworkRow[] = [
  { kind: "connection", fullName: "Mila Osk", company: "Tanmark", position: "Head of Growth", profileUrl: "https://www.linkedin.com/in/mila-osk-12" },
  { kind: "connection", fullName: "Ravi Ten", company: "Tanmark Health", position: "AE", profileUrl: null },
  { kind: "client", fullName: "Ana Pell", company: "Orrin", position: "CMO", profileUrl: null },
  { kind: "employer", fullName: "Contoso", company: "contoso.test", position: null, profileUrl: null },
];
const acct = { name: "Tanmark", domain: "tanmark.test" };

describe("warm paths", () => {
  it("the contact is a connection (same profile)", () => {
    const p = warmPaths({ name: "Mila Osk", linkedin: "https://linkedin.com/in/Mila-Osk-12/" }, acct, net);
    expect(p[0]).toEqual({ kind: "connected", text: "You're connected with Mila Osk on LinkedIn" });
  });
  it("someone you know works there (exact company name only, never fuzzy)", () => {
    const p = warmPaths({ name: "Jo Bard" }, acct, net);
    expect(p.map((x) => x.text)).toEqual(["You know Mila Osk (Head of Growth) there: ask for an intro"]);
  });
  it("a past client now works there (tracked current company)", () => {
    const p = warmPaths({ name: "Jo Bard" }, { name: "Fabrikam", domain: "fabrikam.test" }, [{ ...net[2]!, currentCompany: "Fabrikam" }]);
    expect(p[0]!.kind).toBe("client_there");
  });
  it("shared past employer from the contact's work history", () => {
    const p = warmPaths({ name: "Jo Bard", workHistory: [{ company: "Contoso" }] }, { name: "Nowhere", domain: "nowhere.test" }, net);
    expect(p).toEqual([{ kind: "shared_employer", text: "Jo also worked at Contoso, like you" }]);
  });
  it("same name at another company is not the contact", () => {
    const p = warmPaths({ name: "Mila Osk" }, { name: "Orrin", domain: "orrin.test" }, net);
    expect(p.some((x) => x.kind === "connected")).toBe(false);
  });
});

describe("champion moved", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  const hit = (name: string, roles: { title: string; company: string; current: boolean; from?: string; to?: string }[]) => ({ name, url: "https://linkedin.example/in/ana", roles });
  it("same person (was at Orrin), new current role started 6 weeks ago", () => {
    const m = championMove({ fullName: "Ana Pell", company: "Orrin" }, hit("Ana Pell", [
      { title: "VP Marketing", company: "Fabrikam", current: true, from: "2026-10-01" },
      { title: "CMO", company: "Orrin", current: false, from: "2023-01-01", to: "2026-09-01" },
    ]), now);
    expect(m).toMatchObject({ company: "Fabrikam", title: "VP Marketing" });
  });
  it("a namesake who never worked at Orrin, or a move older than 90 days, is not a move", () => {
    expect(championMove({ fullName: "Ana Pell", company: "Orrin" }, hit("Ana Pell", [{ title: "VP Marketing", company: "Fabrikam", current: true, from: "2026-10-01" }]), now)).toBeNull();
    expect(championMove({ fullName: "Ana Pell", company: "Orrin" }, hit("Ana Pell", [
      { title: "VP Marketing", company: "Fabrikam", current: true, from: "2026-01-01" }, { title: "CMO", company: "Orrin", current: false, to: "2025-12-01" },
    ]), now)).toBeNull();
  });
  it("still at Orrin: no move", () => {
    expect(championMove({ fullName: "Ana Pell", company: "Orrin" }, hit("Ana Pell", [{ title: "CMO", company: "Orrin", current: true, from: "2023-01-01" }]), now)).toBeNull();
  });
});

describe("imports", () => {
  it("LinkedIn Connections.csv: skips the notes, drops emails", () => {
    const csv = `Notes:\n"When exporting your connection data, you may notice..."\n\nFirst Name,Last Name,URL,Email Address,Company,Position,Connected On\nMila,Osk,https://www.linkedin.com/in/mila-osk-12,mila@x.test,"Tanmark, Inc.",Head of Growth,01 Feb 2025\nJo,Bard,https://www.linkedin.com/in/jo,,,,03 Mar 2024\n`;
    const rows = parseLinkedInConnections(csv);
    expect(rows).toEqual([
      { kind: "connection", fullName: "Mila Osk", company: "Tanmark, Inc.", position: "Head of Growth", profileUrl: "https://www.linkedin.com/in/mila-osk-12" },
      { kind: "connection", fullName: "Jo Bard", company: null, position: null, profileUrl: "https://www.linkedin.com/in/jo" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("mila@x.test");
  });
  it("clients CSV needs name and company", () => {
    expect(parseClients("name,company,title\nAna Pell,Orrin,CMO\nNo Company,,x\n")).toEqual([{ kind: "client", fullName: "Ana Pell", company: "Orrin", position: "CMO", profileUrl: null }]);
    expect(() => parseClients("who,where\na,b\n")).toThrow();
  });
});
