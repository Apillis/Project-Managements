// Pure helpers for the finance screens (kept free of React / Supabase so they
// can be unit-tested).
import type { Row } from './types';

export const AGING_BUCKETS = ['current', '1-30', '31-60', '61-90', '>90'] as const;
export type AgingBucket = typeof AGING_BUCKETS[number];

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Open receivables (base currency) per aging bucket of v_receivables rows. */
export function agingSummary(rows: Row[]): Record<AgingBucket, number> {
  const out = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0])) as Record<AgingBucket, number>;
  for (const r of rows) {
    const b = (r.aging_bucket ?? 'current') as AgingBucket;
    if (b in out) out[b] = round2(out[b] + (Number(r.balance_base) || 0));
  }
  return out;
}

const FLOWS = ['actual_in', 'actual_out', 'forecast_in', 'forecast_out'] as const;

/** Company cash flow: v_project_cashflow rows summed per month, with the running total recomputed. */
export function cashflowTotals(rows: Row[]): Row[] {
  const byMonth = new Map<string, Row>();
  for (const r of rows) {
    const month = String(r.month ?? '').slice(0, 10);
    const e = byMonth.get(month) ?? { id: month, month, actual_in: 0, actual_out: 0, forecast_in: 0, forecast_out: 0 };
    for (const f of FLOWS) e[f] = round2(e[f] + (Number(r[f]) || 0));
    byMonth.set(month, e);
  }
  let cumulative = 0;
  return [...byMonth.values()]
    .sort((a, b) => String(a.month).localeCompare(String(b.month)))
    .map((e) => {
      const net = round2(e.actual_in + e.forecast_in - e.actual_out - e.forecast_out);
      cumulative = round2(cumulative + net);
      return { ...e, net_flow: net, cumulative_net: cumulative };
    });
}

/** Codes returned by project_close_check() (same order as the database function). */
export const CLOSE_CHECKS = ['open_activities', 'pending_approvals', 'open_purchase_requests', 'open_purchase_orders',
  'open_material_requests', 'open_ncrs', 'open_compliance', 'open_shipments', 'unbilled_milestones', 'unpaid_invoices',
  'unapproved_timesheets', 'project_stock'] as const;

/** Items of the project closure checklist that still block closing. */
export function closeBlockers(rows: { check_code: string; open_count: number }[]): { check_code: string; open_count: number }[] {
  return rows.filter((r) => Number(r.open_count) > 0);
}
