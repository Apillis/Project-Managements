import { describe, expect, it } from 'vitest';
import { applyFilters, describeFilters, escapeSearch, type Filterable } from '../lib/query';

class Fake implements Filterable<Fake> {
  calls: [string, ...unknown[]][] = [];
  private rec(n: string, ...a: unknown[]) { this.calls.push([n, ...a]); return this; }
  eq(c: string, v: unknown) { return this.rec('eq', c, v); }
  is(c: string, v: null) { return this.rec('is', c, v); }
  in(c: string, v: unknown[]) { return this.rec('in', c, v); }
  gte(c: string, v: unknown) { return this.rec('gte', c, v); }
  lte(c: string, v: unknown) { return this.rec('lte', c, v); }
  or(f: string) { return this.rec('or', f); }
}

describe('applyFilters', () => {
  it('maps project, status, date range and search to PostgREST calls', () => {
    const q = applyFilters(new Fake(), { projectId: 'p1', statuses: ['draft', 'approved'], dateFrom: '2026-01-01', dateTo: '2026-01-31', search: 'motor' },
      { projectColumn: 'project_id', statusColumn: 'status', dateColumn: 'order_date', searchColumns: ['doc_no', 'vendor_name'] });
    expect(q.calls).toEqual([
      ['eq', 'project_id', 'p1'],
      ['in', 'status', ['draft', 'approved']],
      ['gte', 'order_date', '2026-01-01'],
      ['lte', 'order_date', '2026-01-31'],
      ['or', 'doc_no.ilike.*motor*,vendor_name.ilike.*motor*'],
    ]);
  });

  it('includes the whole last day for timestamp columns', () => {
    const q = applyFilters(new Fake(), { dateTo: '2026-01-31' }, { dateColumn: 'created_at' });
    expect(q.calls).toEqual([['lte', 'created_at', '2026-01-31T23:59:59.999']]);
  });

  it('ignores filters the target does not support', () => {
    const q = applyFilters(new Fake(), { projectId: 'p', statuses: ['x'], dateFrom: '2026-01-01' }, {});
    expect(q.calls).toEqual([]);
  });

  it('supports eq / is null extras and skips empty values', () => {
    const q = applyFilters(new Fake(), { eq: { a: 1, b: null, c: '' } }, {});
    expect(q.calls).toEqual([['eq', 'a', 1], ['is', 'b', null]]);
  });

  it('escapes characters that would break the or() syntax', () => {
    expect(escapeSearch(' a,b(c)"d%_ ')).toBe('a b c d\\%\\_');
  });

  it('describes filters for the Excel header', () => {
    const s = describeFilters({ projectId: 'x', statuses: ['draft'], dateFrom: '2026-01-01' }, {
      project: 'PRJ1', status: (v) => v.toUpperCase(), from: 'From', to: 'To', search: 'Search', projectLabel: 'Project', statusLabel: 'Status', dateLabel: 'Date',
    });
    expect(s).toBe('Project: PRJ1 · Status: DRAFT · Date: 2026-01-01 → …');
  });
});
