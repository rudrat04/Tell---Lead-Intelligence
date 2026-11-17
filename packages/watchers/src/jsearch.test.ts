import { describe, it, expect } from "vitest";
import { parseJSearch, jsearchProvider } from "./jsearch.js";

const job = {
  job_id: "abc==", job_title: " Revenue Operations Manager ", employer_name: "Acme Analytics", employer_website: "https://www.acmeanalytics.in",
  job_publisher: "LinkedIn", job_employment_type: "FULLTIME", job_apply_link: "https://www.linkedin.com/jobs/view/1",
  job_posted_at_datetime_utc: "2026-11-10T00:00:00.000Z", job_city: "Pune", job_state: "Maharashtra", job_country: "IN",
};

describe("JSearch parsing", () => {
  it("reads /search-v2 (data.jobs) and the older /search (data[])", () => {
    expect(parseJSearch({ data: { jobs: [job] } })).toHaveLength(1);
    expect(parseJSearch({ data: [job] })).toHaveLength(1);
    expect(parseJSearch({})).toEqual([]);
    expect(parseJSearch(null)).toEqual([]);
  });
  it("normalises fields and skips incomplete rows", () => {
    const [j] = parseJSearch({ data: { jobs: [job, { ...job, job_id: undefined }, { ...job, employer_name: "" }] } });
    expect(j).toMatchObject({ jobId: "abc==", title: "Revenue Operations Manager", employer: "Acme Analytics", website: "https://www.acmeanalytics.in", location: "Pune, Maharashtra, IN", countryCodes: ["IN"] });
    expect(j!.postedAt!.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(parseJSearch({ data: { jobs: [job, { ...job, job_id: undefined }] } })).toHaveLength(1);
  });
  it("bad dates and missing websites become undefined / null", () => {
    const [j] = parseJSearch({ data: [{ ...job, job_posted_at_datetime_utc: "soon", employer_website: null, job_country: "India" }] });
    expect(j!.postedAt).toBeUndefined();
    expect(j!.website).toBeNull();
    expect(j!.countryCodes).toEqual([]);
  });
});

describe("JSearch provider", () => {
  it("prefers the OpenWeb Ninja key, falls back to RapidAPI, else none", () => {
    expect(jsearchProvider({ JSEARCH_API_KEY: "ak_x", RAPIDAPI_KEY: "r" })?.kind).toBe("openwebninja");
    expect(jsearchProvider({ RAPIDAPI_KEY: "r" })?.kind).toBe("rapidapi");
    expect(jsearchProvider({})).toBeNull();
  });
});
