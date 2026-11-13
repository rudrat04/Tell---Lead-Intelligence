import { describe, it, expect } from "vitest";
import { localPart, patternsFor, learnPattern, emailFor, extractAddresses, genericAddress, mailProvider, defaultPattern, isRoleAddress } from "./email.js";

const src = "https://acme.test/team";
const mailOk = { acceptsMail: true, provider: "google", pattern: null };

describe("email patterns", () => {
  it("builds local parts, stripping accents and needing a last name where the pattern does", () => {
    expect(localPart("first.last", "Zoë Quill")).toBe("zoe.quill");
    expect(localPart("flast", "Ravi Tannery")).toBe("rtannery");
    expect(localPart("first", "Ravi Tannery")).toBe("ravi");
    expect(localPart("first.last", "Ravi")).toBeNull();
  });
  it("finds every pattern a local part fits", () => {
    expect(patternsFor("ravi", "Ravi Tannery")).toEqual(["first"]);
    expect(patternsFor("rtannery", "Ravi Tannery")).toEqual(["flast"]);
  });
});

describe("learnPattern", () => {
  it("learns from name-matched addresses only, ignoring role mailboxes and other domains", () => {
    const p = learnPattern([
      { address: "ravi.tannery@acme.test", sourceUrl: src },
      { address: "mila.osk@acme.test", sourceUrl: src },
      { address: "hello@acme.test", sourceUrl: src },
      { address: "dana.verr@gmail.com", sourceUrl: src },
    ], ["Ravi Tannery", "Mila Osk", "Dana Verr"], "acme.test");
    expect(p).toEqual({ pattern: "first.last", confidence: 1, support: 2 });
  });
  it("returns null when no address ties to a known name", () => {
    expect(learnPattern([{ address: "x7@acme.test", sourceUrl: src }], ["Ravi Tannery"], "acme.test")).toBeNull();
  });
  it("splits disagreement into lower confidence", () => {
    const p = learnPattern([
      { address: "ravi@acme.test", sourceUrl: src },
      { address: "mila.osk@acme.test", sourceUrl: src },
    ], ["Ravi Tannery", "Mila Osk"], "acme.test")!;
    expect(p.confidence).toBe(0.5);
  });
});

describe("emailFor", () => {
  it("observed beats everything", () => {
    const g = emailFor("Ravi Tannery", "acme.test", mailOk, [{ address: "RTannery@acme.test", sourceUrl: src }], "11-50")!;
    expect(g).toMatchObject({ address: "rtannery@acme.test", status: "observed", source: src });
  });
  it("uses a confident learned pattern as likely", () => {
    const g = emailFor("Mila Osk", "acme.test", { ...mailOk, pattern: { pattern: "flast", confidence: 1, support: 2 } }, [], "51-200")!;
    expect(g).toMatchObject({ address: "mosk@acme.test", status: "likely" });
  });
  it("falls back to a size-based guess only when the domain takes mail", () => {
    expect(emailFor("Mila Osk", "acme.test", mailOk, [], "1-10")).toMatchObject({ address: "mila@acme.test", status: "guessed" });
    expect(emailFor("Mila Osk", "acme.test", mailOk, [], "201-500")).toMatchObject({ address: "mila.osk@acme.test", status: "guessed" });
    expect(emailFor("Mila Osk", "acme.test", { ...mailOk, acceptsMail: null }, [], "1-10")).toBeNull();
  });
  it("is invalid when the domain does not receive mail", () => {
    expect(emailFor("Mila Osk", "acme.test", { ...mailOk, acceptsMail: false }, [], "1-10")!.status).toBe("invalid");
  });
  it("a weak pattern is not 'likely'", () => {
    const g = emailFor("Mila Osk", "acme.test", { ...mailOk, pattern: { pattern: "flast", confidence: 0.5, support: 2 } }, [], "1-10")!;
    expect(g.status).toBe("guessed");
  });
});

describe("page extraction and helpers", () => {
  it("extracts addresses on the domain, including [at] obfuscation, and skips assets", () => {
    const html = `<a href="mailto:hello@acme.test">x</a> ravi [at] acme.test logo@2x.png@acme.test mila.osk+news@acme.test other@else.test`;
    expect(extractAddresses(html, "acme.test").sort()).toEqual(["hello@acme.test", "mila.osk@acme.test", "ravi@acme.test"]);
  });
  it("prefers founders@ over hello@ over info@ as the shared inbox", () => {
    const seen = ["info@acme.test", "hello@acme.test", "founders@acme.test"].map((address) => ({ address, sourceUrl: src }));
    expect(genericAddress(seen, "acme.test")!.address).toBe("founders@acme.test");
    expect(isRoleAddress("support@acme.test")).toBe(true);
  });
  it("labels mail providers", () => {
    expect(mailProvider(["mx.zoho.in"])).toBe("zoho");
    expect(mailProvider(["acme-test.mail.protection.outlook.com"])).toBe("microsoft");
    expect(mailProvider([])).toBeNull();
    expect(defaultPattern("11-50")).toBe("first");
    expect(defaultPattern(null)).toBe("first.last");
  });
});
