import { describe, it, expect } from "vitest";
import { tenantsFromUrls, ccUrls } from "./commoncrawl.js";
import { parseFreshteamJobs, kekaPostings } from "./india-ats.js";
import { findBoardLinks } from "./board-links.js";

describe("common crawl", () => {
  it("lists tenant labels, skipping vendor subdomains and nested hosts", () => {
    const urls = [
      "https://acmepay.keka.com/careers/jobdetails/12", "https://acmepay.keka.com/careers/", "https://www.keka.com/",
      "https://developers.keka.com/docs", "https://a.b.keka.com/x", "https://zeta-labs.keka.com/careers", "https://notkeka.com/",
    ];
    expect(tenantsFromUrls(urls, "keka.com")).toEqual(["acmepay", "zeta-labs"]);
  });

  it("retries 504s and reports incomplete when a page never loads", async () => {
    let calls = 0;
    const f = (async (u: string) => {
      calls++;
      if (String(u).includes("showNumPages")) return new Response(JSON.stringify({ pages: 2 }));
      if (String(u).includes("page=0")) return calls < 4 ? new Response("", { status: 504 }) : new Response('{"url":"https://acmepay.keka.com/careers"}\n');
      return new Response("", { status: 504 });
    }) as typeof fetch;
    const r = await ccUrls("CC-TEST", "*.keka.com", { fetchImpl: f, retries: 2, backoffMs: 1 });
    expect(r.urls).toEqual(["https://acmepay.keka.com/careers"]);
    expect(r.complete).toBe(false);
  });
});

describe("keka", () => {
  it("normalises jobs with country codes and posted dates", () => {
    const p = kekaPostings("acmepay", [{ id: 7, title: "Head of Growth", publishedOn: "2026-11-01T00:00:00Z", excerpt: "Own growth", jobLocations: [{ city: "Pune", countryCode: "IN", countryName: "India" }] }]);
    expect(p[0]).toMatchObject({ externalId: "7", url: "https://acmepay.keka.com/careers/jobdetails/7", location: "Pune, India", countryCodes: ["IN"], text: "Own growth" });
    expect(p[0]!.postedAt?.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("freshteam", () => {
  const html = `<html><head><title>Acme Pay - Careers</title></head><body><div class="job-role-list" data-portal-id="job-role-list">
    <a href="/jobs/Ab12_x/revops-manager" class="heading" data-portal-title="revopsmanager" data-portal-location="Bengaluru, Karnataka, India" data-portal-job-type="2" data-portal-remote-location=false>
      <div class="row"><div class="job-list-info"><div class="job-title">RevOps Manager</div>
      <div  class="job-desc text">Build our CRM &amp; reporting...</div></div>
      <div class="job-location"><div class="location-info">Bengaluru<br/>Contract</div></div></div></a>
    <a href="https://acmepay.example/about">About</a></div></body></html>`;

  it("parses title, location, employment type and outbound links", () => {
    const r = parseFreshteamJobs(html, "acmepay");
    expect(r.name).toBe("Acme Pay");
    expect(r.postings).toEqual([{
      externalId: "Ab12_x", title: "RevOps Manager", url: "https://acmepay.freshteam.com/jobs/Ab12_x/revops-manager",
      employmentType: "Contract", location: "Bengaluru, Karnataka, India", text: "Build our CRM & reporting...",
    }]);
    expect(r.links).toEqual(["https://acmepay.example/about"]);
  });
});

describe("board links on a company's own site", () => {
  it("finds Keka and Freshteam tenants", () => {
    const refs = findBoardLinks('<a href="https://acmepay.keka.com/careers/">Jobs</a> <a href="https://zeta.freshteam.com/jobs">x</a> <a href="https://www.keka.com/hr">keka</a>');
    expect(refs).toEqual([{ ats: "keka", slug: "acmepay" }, { ats: "freshteam", slug: "zeta" }]);
  });
});
