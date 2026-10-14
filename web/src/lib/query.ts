// Pure helpers that translate UI filters into a PostgREST query. Kept free of
// React/Supabase types so they can be unit-tested with a fake builder.

export interface ActiveFilters {
  projectId?: string;
  statuses?: string[];
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  eq?: Record<string, string | number | boolean | null>;
}

export interface FilterTarget {
  projectColumn?: string;
  statusColumn?: string;
  dateColumn?: string;
  searchColumns?: string[];
}

/** Subset of the PostgREST builder we use (structural typing). */
export interface Filterable<T> {
  eq(column: string, value: unknown): T;
  is(column: string, value: null): T;
  in(column: string, values: unknown[]): T;
  gte(column: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  or(filter: string): T;
}

/** Escape a search term for a PostgREST `or=(col.ilike.*x*)` expression. */
export function escapeSearch(text: string): string {
  return text.trim().replace(/[%_]/g, (m) => '\\' + m).replace(/[(),"]/g, ' ').replace(/\s+/g, ' ');
}

export function applyFilters<T extends Filterable<T>>(q: T, f: ActiveFilters, target: FilterTarget): T {
  let out = q;
  if (f.projectId && target.projectColumn) out = out.eq(target.projectColumn, f.projectId);
  if (f.statuses && f.statuses.length && target.statusColumn) out = out.in(target.statusColumn, f.statuses);
  if (target.dateColumn) {
    if (f.dateFrom) out = out.gte(target.dateColumn, f.dateFrom);
    if (f.dateTo) out = out.lte(target.dateColumn, endOfDay(f.dateTo, target.dateColumn));
  }
  if (f.eq) {
    for (const [k, v] of Object.entries(f.eq)) {
      if (v === undefined || v === '') continue;
      out = v === null ? out.is(k, null) : out.eq(k, v);
    }
  }
  const s = f.search ? escapeSearch(f.search) : '';
  if (s && target.searchColumns && target.searchColumns.length) {
    out = out.or(target.searchColumns.map((c) => `${c}.ilike.*${s}*`).join(','));
  }
  return out;
}

/** For timestamp columns an inclusive "to" date must include the whole day. */
function endOfDay(date: string, column: string): string {
  return /(_at|move_date|reported_at)$/.test(column) && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T23:59:59.999` : date;
}

/** Human readable summary of the filters (printed on Excel exports). */
export function describeFilters(f: ActiveFilters, labels: { project?: string; status: (s: string) => string; from: string; to: string; search: string; projectLabel: string; statusLabel: string; dateLabel: string }): string {
  const parts: string[] = [];
  if (f.projectId) parts.push(`${labels.projectLabel}: ${labels.project ?? f.projectId}`);
  if (f.statuses?.length) parts.push(`${labels.statusLabel}: ${f.statuses.map(labels.status).join(', ')}`);
  if (f.dateFrom || f.dateTo) parts.push(`${labels.dateLabel}: ${f.dateFrom ?? '…'} → ${f.dateTo ?? '…'}`);
  if (f.search) parts.push(`${labels.search}: "${f.search}"`);
  return parts.join(' · ');
}
