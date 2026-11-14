import { describe, it, expect } from "vitest";
import { parseIndex, parseCompanyPage } from "./portfolio.js";

describe("portfolio pages", () => {
  it("lists company pages and the next index page", () => {
    const html = `<a href="/companies/tanmark">T</a><a href="/companies/orrin/">O</a><a href="/about">x</a><a href="?c4_page=2">Next Page</a><a href="?c4_page=3">3</a>`;
    expect(parseIndex(html, "https://vc.test/companies?c4_page=1", "/companies/")).toEqual({
      companies: ["https://vc.test/companies/tanmark", "https://vc.test/companies/orrin"], pages: ["https://vc.test/companies?c4_page=2", "https://vc.test/companies?c4_page=3"],
    });
  });
  it("takes only the link labelled Website, never another external link", () => {
    const html = `<h1>Tanmark</h1><a href="https://tracker.test/x">t</a><div class="tag">Website</div><a href="https://tanmark.test/" target="_blank">↗</a>`;
    expect(parseCompanyPage(html)).toEqual({ name: "Tanmark", website: "https://tanmark.test/" });
    expect(parseCompanyPage(`<h1>Orrin</h1><a href="https://orrin.test/">site</a>`).website).toBeNull();
    expect(parseCompanyPage(`<h1>Orrin</h1><div>Get to know them</div><a href="https://orrin.test/">↗</a>`, ["website", "get to know them"]).website).toBe("https://orrin.test/");
  });
  it("reads the link from an aria-label anchor, skipping the site's own relative 'Website Logo' link", () => {
    const html = `<h1>Orrin</h1><a aria-label="Acme Website Logo" href="/">x</a><a aria-label="Visit Orrin Website" href="https://orrin.test/">y</a>`;
    expect(parseCompanyPage(html, ["website"]).website).toBe("https://orrin.test/");
  });
});
