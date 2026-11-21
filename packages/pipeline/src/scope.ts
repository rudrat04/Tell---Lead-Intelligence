import { industriesIgnoring, type Pack } from "@tell/config";
import { sql, type SQL } from "@tell/db";

/** SQL twin of intel's regionInScope(): accounts whose region the pack can ever score (`true` without regions_any). */
export function regionInScopeSql(pack: Pack, regionColumn: SQL | unknown): SQL {
  const any = pack.icp.hard_filters.regions_any;
  if (!any.length) return sql`true`;
  return sql`${regionColumn} in (${sql.join(any.map((r) => sql`${r}`), sql`, `)})`;
}

/** What the site / DNS / infra watch writes: GTM states and events, meaningless for a drug maker or a contractor. */
export const WATCH_SIGNAL_TYPES = ["attribution_gap", "content_motion", "cta_sales_led", "email_auth_gap", "funding_raise", "gtm_tool_added", "has_gtm_agency",
  "leaky_capture", "pricing_page_added", "product_launch", "site_health_poor", "stack_sprawl", "tool_overlap", "marketing_subdomain", "outbound_domain", "tool_sunset"];

/** Accounts in an industry that counts at least one of `types` (industries.yaml `signals`), or whose industry is
 *  unknown / unscoped: watchers skip the rest instead of fetching pages whose findings scoring would drop. */
export function industryCountsSql(pack: Pack, segmentColumn: SQL | unknown, types: string[]): SQL {
  const skip = industriesIgnoring(pack, types);
  if (!skip.length) return sql`true`;
  return sql`(${segmentColumn} is null or ${segmentColumn} not in (${sql.join(skip.map((x) => sql`${x}`), sql`, `)}))`;
}
