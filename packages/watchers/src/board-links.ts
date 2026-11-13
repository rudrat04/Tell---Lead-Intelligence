import type { Ats } from "./ats-boards.js";

/** Job-board links found in a company's own pages. A board linked from the company's own site proves ownership. */
export interface BoardRef { ats: Ats; slug: string }

const PATTERNS: [Ats, RegExp][] = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([a-z0-9_-]+)/gi],
  ["greenhouse", /greenhouse\.io\/embed\/job_board(?:\/js)?\?for=([a-z0-9_-]+)/gi],
  ["greenhouse", /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/gi],
  ["lever", /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_.-]+)/gi],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+)/gi],
  ["ashby", /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.%-]+)/gi],
  // tenant subdomains: the slug is the tenant (Keka's stored slug adds its GUID after discovery)
  ["keka", /\/\/([a-z0-9][a-z0-9-]*)\.keka\.com\/careers/gi],
  ["freshteam", /\/\/([a-z0-9][a-z0-9-]*)\.freshteam\.com\/jobs/gi],
  // apply.workable.com/<subdomain> (not /j/<shortcode> job links or /api/), and <subdomain>.workable.com
  ["workable", /apply\.workable\.com\/(?!j\/|api\/)([a-z0-9][a-z0-9-]*)/gi],
  ["workable", /\/\/(?!apply\.|jobs\.|www\.)([a-z0-9][a-z0-9-]*)\.workable\.com/gi],
];

const JUNK = new Set(["embed", "api", "v1", "jobs", "js", "static", "assets", "careers"]);

export function findBoardLinks(html: string): BoardRef[] {
  const out = new Map<string, BoardRef>();
  for (const [ats, re] of PATTERNS) {
    for (const m of html.matchAll(re)) {
      const slug = decodeURIComponent(m[1]!).toLowerCase().replace(/[.]+$/, "");
      if (!slug || JUNK.has(slug)) continue;
      out.set(`${ats}:${slug}`, { ats, slug });
    }
  }
  return [...out.values()];
}
