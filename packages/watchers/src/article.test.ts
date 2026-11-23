import { describe, it, expect } from "vitest";
import { articleText, isRecordUrl } from "./article.js";

describe("article text", () => {
  it("keeps the article's paragraphs and drops navigation, scripts and footers", () => {
    const html = `<html><body><nav><p>Home Markets Companies Opinion and more links here</p></nav>
      <article><h1>Contoso Lifesciences starts building its new plant in Gujarat</h1>
      <p>Contoso Lifesciences said on Monday it has started construction of its new oral solid dosage plant.</p>
      <script>var x = "tracking code that should never be read";</script>
      <p>The plant will make 2 billion tablets a year and employ 400 people.</p></article>
      <footer><p>Copyright notice and all the links at the bottom of every page</p></footer></body></html>`;
    const t = articleText(html);
    expect(t).toContain("has started construction of its new oral solid dosage plant");
    expect(t).toContain("2 billion tablets a year");
    expect(t).not.toMatch(/tracking code|Copyright notice|Home Markets/);
  });
  it("records (APIs, data portals) are checked on their stored quote, not fetched", () => {
    expect(isRecordUrl("https://api.fda.gov/drug/drugsfda.json?search=x")).toBe(true);
    expect(isRecordUrl("https://data.cityofnewyork.us/resource/ipu4-2q9a.json")).toBe(true);
    expect(isRecordUrl("https://www.example-news.in/business/contoso-starts-plant")).toBe(false);
  });
});
