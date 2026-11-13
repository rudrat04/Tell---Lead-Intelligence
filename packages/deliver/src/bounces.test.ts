import { describe, it, expect } from "vitest";
import { failedRecipients, type GmailMessage } from "./bounces.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const from = (v: string) => ({ name: "From", value: v });
const daemon = from("Mail Delivery Subsystem <mailer-daemon@googlemail.com>");

const dsn = (blocks: string): GmailMessage => ({
  id: "1",
  payload: { mimeType: "multipart/report", headers: [daemon], parts: [
    { mimeType: "text/plain", body: { data: b64("Address not found") } },
    { mimeType: "message/delivery-status", body: { data: b64(`Reporting-MTA: dns; googlemail.com\n\n${blocks}`) } },
  ] },
});

describe("failedRecipients", () => {
  it("reads permanent failures from the delivery-status report", () => {
    expect(failedRecipients(dsn("Final-Recipient: rfc822; Mila.Osk@acme.test\nAction: failed\nStatus: 5.1.1"))).toEqual(["mila.osk@acme.test"]);
  });
  it("ignores temporary failures and delays", () => {
    expect(failedRecipients(dsn("Final-Recipient: rfc822; ravi@acme.test\nAction: failed\nStatus: 4.2.2"))).toEqual([]);
    expect(failedRecipients(dsn("Final-Recipient: rfc822; ravi@acme.test\nAction: delayed\nStatus: 4.4.1"))).toEqual([]);
  });
  it("handles several recipients, keeping only the failed ones", () => {
    const m = dsn("Final-Recipient: rfc822; a.one@acme.test\nAction: failed\nStatus: 5.1.1\n\nFinal-Recipient: rfc822; b.two@acme.test\nAction: delivered\nStatus: 2.0.0");
    expect(failedRecipients(m)).toEqual(["a.one@acme.test"]);
  });
  it("falls back to X-Failed-Recipients, then Gmail's wording", () => {
    expect(failedRecipients({ id: "2", payload: { headers: [daemon, { name: "X-Failed-Recipients", value: "dana@orrin.test" }] } })).toEqual(["dana@orrin.test"]);
    expect(failedRecipients({ id: "3", snippet: "Address not found Your message wasn't delivered to dana@orrin.test because the address couldn't be found", payload: { headers: [daemon] } })).toEqual(["dana@orrin.test"]);
  });
  it("only trusts messages from a mail daemon", () => {
    expect(failedRecipients({ id: "4", snippet: "your message wasn't delivered to dana@orrin.test", payload: { headers: [from("Dana <dana@orrin.test>")] } })).toEqual([]);
  });
  it("doesn't treat a 'will retry' notice as a bounce", () => {
    expect(failedRecipients({ id: "5", snippet: "Delivery incomplete. There was a temporary problem delivering your message to dana@orrin.test. Gmail will retry", payload: { headers: [daemon] } })).toEqual([]);
  });
});
