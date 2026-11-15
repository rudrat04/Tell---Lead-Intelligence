import { describe, it, expect } from "vitest";
import { extractForms, extractSiteFacts } from "./site.js";
import { parsePageSpeed } from "./pagespeed.js";

describe("demo forms (attribution gap input)", () => {
  it("reads a plain HTML form: fields, email, no source question", () => {
    const html = `<form action="/api/demo"><label for="n">Name</label><input id="n" name="name"><input type="email" name="email">
      <input name="company" placeholder="Company"><select name="size"><option>1-10</option><option>11-50</option></select>
      <input type="hidden" name="page" value="demo"><button type="submit">Book</button></form>`;
    expect(extractForms(html)).toEqual([{ fields: 4, hasEmail: true, asksSource: false }]);
  });
  it("a 'how did you hear about us' field, a source dropdown or a hidden utm field counts as asking", () => {
    expect(extractForms(`<form><input type="email" name="email"><input name="name"><input name="company"><label>How did you hear about us? <input name="q7"></label></form>`)[0]!.asksSource).toBe(true);
    expect(extractForms(`<form><input type="email" name="email"><input name="name"><select name="x"><option>Google</option><option>Referral</option></select></form>`)[0]!.asksSource).toBe(true);
    expect(extractForms(`<form><input type="email" name="email"><input name="name"><input name="co"><input type="hidden" name="utm_source"></form>`)[0]!.asksSource).toBe(true);
  });
  it("a form-builder embed has nothing readable", () => {
    expect(extractForms(`<div id="hs-form"></div><script src="https://js.hsforms.net/forms/embed/v2.js"></script>`)).toEqual([]);
  });
});

describe("homepage facts: demo link and content channels", () => {
  it("finds where the sales-led button points, skipping anchors and mailto", () => {
    const f = extractSiteFacts(`<a href="#top">Book a demo</a><a href="mailto:hi@acme.test">Talk to sales</a><a href="/demo">Book a demo</a>`, []);
    expect(f.demoUrl).toBe("/demo");
  });
  it("lists blog, podcast and newsletter links", () => {
    const f = extractSiteFacts(`<a href="/blog/">Blog</a><a href="https://open.spotify.com/show/abc">Podcast</a><a href="https://acme.substack.com">News</a>`, []);
    expect(f.contentLinks).toEqual(["blog", "podcast", "newsletter"]);
  });
});

describe("PageSpeed response", () => {
  it("performance score 0-100 and LCP in ms", () => {
    expect(parsePageSpeed({ lighthouseResult: { categories: { performance: { score: 0.31 } }, audits: { "largest-contentful-paint": { numericValue: 6812.4 } } } })).toEqual({ score: 31, lcpMs: 6812 });
  });
  it("a run without a score is no result", () => {
    expect(parsePageSpeed({ lighthouseResult: { categories: { performance: { score: null } } } })).toBeNull();
    expect(parsePageSpeed({ error: { code: 500 } })).toBeNull();
  });
});
