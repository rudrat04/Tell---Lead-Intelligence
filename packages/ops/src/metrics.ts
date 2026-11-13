import { getDb, evalResults, sql } from "@tell/db";

/**
 * Nightly production metrics (plan section 13 + the operator's eval requirements), written to eval_results:
 *  - India coverage at each stage (tracked, scored today, delivered)
 *  - people, not accounts: share of delivered leads with a named contact, and with a non-founder contact
 *  - signal mix: share of delivered leads backed by a non-hiring signal
 *  - labels: count and precision (good / labelled) once you start labelling in the Sheet
 */
export interface Metric { metric: string; value: number; detail?: Record<string, unknown> }

const NON_HIRING = ["explicit_hire_request", "pain_post", "funding_raise", "product_launch", "cta_sales_led", "pricing_page_added", "gtm_tool_added", "stack_sprawl"];

export async function computeMetrics(opts: { write?: boolean } = {}): Promise<Metric[]> {
  const db = getDb();
  const one = async <T>(q: ReturnType<typeof sql>) => ((await db.execute(q)).rows[0] ?? {}) as T;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);
  const out: Metric[] = [];

  const tracked = await one<{ india: number; total: number }>(sql`select count(*) filter (where region = 'India')::int as india, count(*)::int as total from accounts where status = 'active'`);
  out.push({ metric: "india_share_tracked", value: ratio(tracked.india, tracked.total), detail: tracked });

  const scored = await one<{ india: number; total: number }>(sql`
    select count(*) filter (where a.region = 'India')::int as india, count(*)::int as total
    from (select distinct account_id from scores where created_at > now() - interval '1 day') s join accounts a on a.id = s.account_id`);
  out.push({ metric: "india_share_scored", value: ratio(scored.india, scored.total), detail: scored });

  const delivered = await one<{ india: number; total: number; named: number; nonfounder: number; nonhiring: number }>(sql`
    select count(*) filter (where a.region = 'India')::int as india,
           count(*)::int as total,
           count(*) filter (where coalesce(d.sheet_row->>1, '') <> '')::int as named,
           count(*) filter (where coalesce(d.sheet_row->>1, '') <> '' and coalesce(d.sheet_row->>2, '') !~* '(founder|ceo|chief executive)')::int as nonfounder,
           count(*) filter (where exists (select 1 from signals s where s.account_id = d.account_id
             and s.type = any(string_to_array(${NON_HIRING.join(",")}, ',')) and s.observed_at > d.delivered_at - interval '30 days' and s.observed_at <= d.delivered_at))::int as nonhiring
    from deliveries d join accounts a on a.id = d.account_id where d.delivered_at > now() - interval '30 days'`);
  out.push({ metric: "india_share_delivered_30d", value: ratio(delivered.india, delivered.total), detail: { india: delivered.india, total: delivered.total } });
  out.push({ metric: "named_contact_rate_30d", value: ratio(delivered.named, delivered.total), detail: { named: delivered.named, total: delivered.total } });
  out.push({ metric: "non_founder_contact_rate_30d", value: ratio(delivered.nonfounder, delivered.total), detail: { nonfounder: delivered.nonfounder, total: delivered.total } });
  out.push({ metric: "non_hiring_lead_share_30d", value: ratio(delivered.nonhiring, delivered.total), detail: { nonhiring: delivered.nonhiring, total: delivered.total } });

  const labels = await one<{ labelled: number; good: number; outcomes: number }>(sql`
    select count(*) filter (where l.label in ('good','bad'))::int as labelled, count(*) filter (where l.label = 'good')::int as good,
           count(*) filter (where l.outcome is not null)::int as outcomes
    from labels l join deliveries d on d.id = l.delivery_id where d.delivered_at > now() - interval '30 days'`);
  out.push({ metric: "label_count_30d", value: labels.labelled, detail: labels });
  out.push({ metric: "precision_30d", value: ratio(labels.good, labels.labelled), detail: labels });

  if (opts.write !== false) {
    await db.insert(evalResults).values(out.map((m) => ({ metric: m.metric, value: m.value, detail: m.detail ?? null })));
  }
  return out;
}
