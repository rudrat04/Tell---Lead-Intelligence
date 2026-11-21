import { describe, it, expect } from "vitest";
import { loadFixturePack } from "@tell/config";
import type { ScoreRunResult } from "@tell/pipeline";
import type { AccountScore, Evidence } from "@tell/intel";
import { tgEsc, chunks, leadMessage, summaryMessage, sendTelegram, tgScore } from "./telegram.js";

const pack = await loadFixturePack();
const ev: Evidence = { type: "core_role_open_45d", class: "implicit", ageDays: 0, current: true, openDays: 60, quote: "GTM <Engineer>", url: "https://jobs.example/1", ref: { kind: "job", id: "j1" } };
const score = { intent: 0.5, fit: 0.9, timing: 1, priority: 0.45, parts: { need: 20, fit: 9, timing: 10, buyer: 6 }, baseRate: 0.02, lane: "combined", eligible: true, evidence: [ev], drivers: [ev], plays: [{ id: "p", title: "Struggling to hire", angle: "a", evidence: [ev] }] } as AccountScore;
const lead = { account: { id: "a1", domain: "northwind.test", name: "Northwind & Co", sizeBand: "11-50", region: "India", segment: "software", description: "makes <billing> software" }, score, incomplete: false, recentlyDelivered: false, newSinceDelivery: false, group: "India" };
const D = "11111111-2222-4333-8444-555555555555";

describe("telegram delivery", () => {
  it("escapes HTML and splits long text at lines", () => {
    expect(tgEsc("A & <b>")).toBe("A &amp; &lt;b&gt;");
    const parts = chunks(Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n"), 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n").split("\n")).toHaveLength(300);
  });
  it("a lead message: company facts, who to reach, play, why we picked them, signals for them, the draft; buttons", () => {
    const c = { person: { name: "Asha Rao", role: "Head of Sales", email: { address: "asha@northwind.test", status: "likely" as const, note: "" } }, persona: "Head of Sales", note: "" };
    const note = { hypothesis: "New plant, nobody selling the extra output yet.", angle: "Buyers for the new capacity", opener: "", counterEvidence: null, confidence: 0.5, brief: "the brief",
      email: { subject: "nashik plant", body: "saw the new plant.\n\nwho handles new buyers?" }, market: [{ title: "Your buyers are building new capacity", example: "Contoso Foods opens a plant in Pune", url: "https://news.example/2" }] };
    const m = leadMessage(lead as any, c as any, note, D, "2026-11-21", { ...pack, copy: { ...pack.copy, greeting: "Hi {first}," } } as any);
    expect(m.text).toContain("🏢 <b><a href=\"https://northwind.test\">Northwind &amp; Co</a></b>\nSoftware · India · 11-50 people\nScore 45");
    expect(m.text).toContain("👤 <b>Reach out to:</b> Asha Rao, Head of Sales\nBuyer type: Head of Sales");
    expect(m.text).toContain("🎯 <b>Play: Struggling to hire</b>");
    expect(m.text).toContain("<b>Why now:</b> New plant, nobody selling the extra output yet.");
    expect(m.text).toContain("📡 <b>Why we picked them</b>");
    expect(m.text).toContain("💡 <b>Signals that would help them</b>\n• <b>Your buyers are building new capacity</b>: <a href=\"https://news.example/2\">Contoso Foods opens a plant in Pune</a>");
    expect(m.text).toContain("<b>Subject:</b> nashik plant\n\nHi Asha,");
    expect(m.buttons!.flat().map((b) => b.data)).toEqual([`g:${D}`, `b:${D}`, `e:${D}`, `br:${D}`]);
    const verified = leadMessage(lead as any, { ...c, person: { ...c.person, email: { ...c.person.email, status: "verified" as const } } } as any, undefined, D, "2026-11-21", pack);
    expect(verified.buttons!.flat().map((b) => b.data)).toEqual([`g:${D}`, `b:${D}`]);
    expect(leadMessage(lead as any, c as any, undefined, D, "2026-11-21", pack, true).buttons).toBeUndefined();
  });
  it("judged leads show the judge's ratings, not the old parts", () => {
    const judged = { ...lead, score: { ...score, priority: 0.72, judged: { rubric: { specific: 4, urgent: 3, prize: 2, deliverable: 4 }, learnedRate: null, learnedN: 0 } } };
    expect(tgScore(judged.score as any)).toBe("Score 72 · specific 4/5 · urgent 3/5 · prize 2/5 · deliverable 4/5");
  });
  it("summary counts leads per list", () => {
    const r = { ranking: { leads: [lead, { ...lead, group: "Niche" }], watchlist: [], held: { incomplete: 0, recentlyDelivered: 0 } } } as unknown as ScoreRunResult;
    expect(summaryMessage(r, "2026-11-21", { touchBacks: 2 }).text).toBe("<b>2 leads for 2026-11-21</b>\n• India: 1\n• Niche: 1\n↩️ 2 past leads have a new fact (Touch back in the Sheet)");
  });
  it("sends in order with the keyboard on the last part, and retries a 429 once", async () => {
    const sent: any[] = []; let first = true;
    const f = (async (_u: string, init: RequestInit) => { if (first) { first = false; return new Response(JSON.stringify({ parameters: { retry_after: 0 } }), { status: 429 }); } sent.push(JSON.parse(init.body as string)); return new Response("{}", { status: 200 }); }) as typeof fetch;
    const n = await sendTelegram([{ text: "hi", buttons: [[{ text: "👍", data: `g:${D}` }]] }], { token: "t", chatId: "42", fetcher: f, pauseMs: 0 });
    expect(n).toBe(1);
    expect(sent[0]).toMatchObject({ chat_id: "42", text: "hi", parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "👍", callback_data: `g:${D}` }]] } });
  });
});
