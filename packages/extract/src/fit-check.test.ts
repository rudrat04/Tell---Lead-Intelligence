import { describe, it, expect } from "vitest";
import { validateFit, checkFit } from "./fit-check.js";

const pages = [
  { url: "https://datum.example/", text: "Datum Life Sciences makes APIs for regulated markets. Our USFDA-inspected site in Gujarat." },
  { url: "https://datum.example/products", text: "Product list: Apixaban, Rivaroxaban, Dabigatran etexilate mesylate, Ticagrelor." },
];
const yes = (proof: string, page = 2) => JSON.stringify({ need: "apixaban API", verdict: "yes", proof, page, reason: "in their product list" });

describe("proof of fit from their own site", () => {
  it("a yes stands only with a quote that is really on their site", () => {
    expect(validateFit(yes("Product list: Apixaban, Rivaroxaban, Dabigatran etexilate mesylate, Ticagrelor."), pages)).toMatchObject({ verdict: "yes", url: "https://datum.example/products", need: "apixaban API" });
    // quoted from another page than the one named: still found, with the right URL
    expect(validateFit(yes("Datum Life Sciences makes APIs for regulated markets.", 2), pages)).toMatchObject({ verdict: "yes", url: "https://datum.example/" });
    // an invented quote (the molecule isn't on the site) is not proof
    expect(validateFit(yes("Product list: Apixaban, Edoxaban and Warfarin."), pages)).toMatchObject({ verdict: "unclear", reason: "the quote is not on their site" });
    expect(validateFit(yes("APIs."), pages).verdict).toBe("unclear");
  });
  it("no and unclear carry no proof; a broken reply is unclear", () => {
    expect(validateFit(JSON.stringify({ need: "clearing to the UAE", verdict: "no", proof: "", page: 0, reason: "they only handle Europe" }), pages)).toMatchObject({ verdict: "no", proof: null });
    expect(validateFit("not json", pages).verdict).toBe("unclear");
  });
  it("no readable site = nothing to prove, no model call", async () => {
    let called = false;
    const r = await checkFit({ complete: async () => { called = true; return ""; } }, { event: "e", opportunity: "o", angle: "", company: "c", pages: [] });
    expect(r.verdict).toBe("unclear");
    expect(called).toBe(false);
  });
});
