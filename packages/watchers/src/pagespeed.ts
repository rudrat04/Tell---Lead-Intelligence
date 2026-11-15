/**
 * Google PageSpeed Insights API (v5), mobile strategy, performance category only. Free with an API key
 * (PAGESPEED_API_KEY; about 25k requests a day). Google runs Lighthouse on its own servers: we never load the page.
 */
export interface PageSpeedResult { score: number; lcpMs: number | null }

/** Parse the API response: performance score 0-100 and Largest Contentful Paint. Null when the run had no score. */
export function parsePageSpeed(j: unknown): PageSpeedResult | null {
  const lh = (j as { lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, { numericValue?: number }> } })?.lighthouseResult;
  const score = lh?.categories?.performance?.score;
  if (typeof score !== "number") return null;
  const lcp = lh?.audits?.["largest-contentful-paint"]?.numericValue;
  return { score: Math.round(score * 100), lcpMs: typeof lcp === "number" ? Math.round(lcp) : null };
}

export async function pageSpeed(url: string, apiKey: string, timeoutMs = 60_000): Promise<PageSpeedResult | null> {
  const q = new URLSearchParams({ url, strategy: "mobile", category: "performance", key: apiKey });
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parsePageSpeed(await res.json());
  } catch {
    return null;
  }
}
