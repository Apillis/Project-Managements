import { describe, expect, it } from 'vitest';
import { AGING_BUCKETS, agingSummary, cashflowTotals, closeBlockers } from '../lib/finance';
import { DOC_ROUTE, E, RESOURCES, docPath } from '../lib/resources';

describe('receivables aging', () => {
  it('sums open balances per bucket and ignores unknown buckets', () => {
    const s = agingSummary([
      { aging_bucket: 'current', balance_base: '100.10' }, { aging_bucket: 'current', balance_base: 0.2 },
      { aging_bucket: '31-60', balance_base: 50 }, { aging_bucket: '>90', balance_base: '7' }, { aging_bucket: 'weird', balance_base: 999 },
      { aging_bucket: null, balance_base: 1 },
    ]);
    expect(Object.keys(s)).toEqual([...AGING_BUCKETS]);
    expect(s).toEqual({ current: 101.3, '1-30': 0, '31-60': 50, '61-90': 0, '>90': 7 });
  });
});

describe('company cash flow', () => {
  it('sums projects per month, sorts months and recomputes the running total', () => {
    const rows = cashflowTotals([
      { project_id: 'b', month: '2026-11-01', actual_in: 0, actual_out: 0, forecast_in: 300, forecast_out: 50 },
      { project_id: 'a', month: '2026-10-01', actual_in: '1000', actual_out: '400', forecast_in: 0, forecast_out: 0 },
      { project_id: 'b', month: '2026-10-01', actual_in: 0, actual_out: 100.1, forecast_in: 0, forecast_out: 0 },
      { project_id: 'a', month: '2026-11-01', actual_in: 0, actual_out: 0, forecast_in: 0, forecast_out: 900 },
    ]);
    expect(rows.map((r) => r.month)).toEqual(['2026-10-01', '2026-11-01']);
    expect(rows[0]).toMatchObject({ actual_in: 1000, actual_out: 500.1, net_flow: 499.9, cumulative_net: 499.9 });
    expect(rows[1]).toMatchObject({ forecast_in: 300, forecast_out: 950, net_flow: -650, cumulative_net: -150.1 });
  });
  it('returns nothing for no rows', () => {
    expect(cashflowTotals([])).toEqual([]);
  });
});

describe('project closure checklist', () => {
  it('keeps only the items that still block closing', () => {
    expect(closeBlockers([{ check_code: 'open_ncrs', open_count: 2 }, { check_code: 'open_activities', open_count: 0 }]))
      .toEqual([{ check_code: 'open_ncrs', open_count: 2 }]);
  });
});

describe('approval routes', () => {
  it('every approvable document type opens an existing detail page', () => {
    for (const d of E.docType) {
      const key = DOC_ROUTE[d];
      expect(RESOURCES[key]?.docType, d).toBe(d);
      expect(docPath(d, 'x1')).toBe(`/r/${key}/x1`);
    }
    expect(docPath('unknown', 'x')).toBe('/approvals');
  });
});
