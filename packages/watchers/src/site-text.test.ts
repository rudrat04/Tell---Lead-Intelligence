import { describe, it, expect } from "vitest";
import { pageTextAndLinks, pickPages } from "./site-text.js";

describe("reading a company's own site", () => {
  it("keeps visible text and same-site links; drops scripts, other sites and files", () => {
    const html = `<html><body><script>var x=1</script><h1>Datum</h1><p>We make   APIs.</p>
      <a href="/products">Products</a><a href="https://other.example/x">Partner</a><a href="/brochure.pdf">PDF</a><a href="/about#team">About</a></body></html>`;
    const r = pageTextAndLinks(html, "https://www.datum.example/");
    expect(r.text).toBe("Datum We make APIs. Products Partner PDF About");
    expect(r.links.map((l) => l.url)).toEqual(["https://www.datum.example/products", "https://www.datum.example/about"]);
  });
  it("reads the event's own words first, then product / market pages", () => {
    const links = [{ url: "https://d.example/careers", label: "Careers" }, { url: "https://d.example/products", label: "Products" }, { url: "https://d.example/apixaban", label: "Apixaban" }, { url: "https://d.example/blog", label: "Blog" }];
    expect(pickPages(links, ["apixaban"], 2)).toEqual(["https://d.example/apixaban", "https://d.example/products"]);
  });
});
