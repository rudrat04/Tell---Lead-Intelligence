import type { Pack } from "@tell/config";
import { sql, type SQL } from "@tell/db";

/** SQL twin of intel's regionInScope(): accounts whose region the pack can ever score (`true` without regions_any). */
export function regionInScopeSql(pack: Pack, regionColumn: SQL | unknown): SQL {
  const any = pack.icp.hard_filters.regions_any;
  if (!any.length) return sql`true`;
  return sql`${regionColumn} in (${sql.join(any.map((r) => sql`${r}`), sql`, `)})`;
}
