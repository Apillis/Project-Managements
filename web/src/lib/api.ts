import { supabase } from './supabase';
import { applyFilters, type ActiveFilters, type FilterTarget } from './query';
import type { RefDef, Row } from './types';

/** Map database / network errors to an i18n key when we know them, else the raw message. */
export function errorKey(err: unknown): { key?: string; raw: string } {
  const e = err as { message?: string; code?: string; details?: string } | null;
  const raw = e?.message ?? String(err);
  if (/row-level security|permission denied|42501/i.test(raw) || e?.code === '42501') return { key: 'm.noPermission', raw };
  if (/duplicate key/i.test(raw)) return { key: 'm.duplicate', raw };
  if (/violates foreign key/i.test(raw)) return { key: 'm.inUse', raw };
  if (/Failed to fetch|NetworkError/i.test(raw)) return { key: 'm.network', raw };
  if (/JWT expired/i.test(raw)) return { key: 'm.sessionExpired', raw };
  if (/Database error saving new user|domain .* not allowed/i.test(raw)) return { key: 'm.domainNotAllowed', raw };
  if (/Invalid login credentials/i.test(raw)) return { key: 'm.badLogin', raw };
  return { raw };
}

export async function must<T>(p: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data;
}

export interface ListParams {
  source: string;
  filters: ActiveFilters;
  target: FilterTarget;
  sort?: { column: string; asc: boolean };
  page?: number;
  pageSize?: number;
  select?: string;
}

export async function fetchPage(p: ListParams): Promise<{ rows: Row[]; count: number }> {
  const size = p.pageSize ?? 50;
  const page = p.page ?? 0;
  let q = supabase.from(p.source).select(p.select ?? '*', { count: 'exact' });
  q = applyFilters(q, p.filters, p.target);
  if (p.sort) q = q.order(p.sort.column, { ascending: p.sort.asc, nullsFirst: false });
  q = q.range(page * size, page * size + size - 1);
  const { data, error, count } = await q;
  if (error) throw error;
  return { rows: (data as unknown as Row[]) ?? [], count: count ?? 0 };
}

/** Fetch every row (in chunks of 1000) for exports. */
export async function fetchAll(source: string, filters: ActiveFilters, target: FilterTarget,
  orderBy: { column: string; asc?: boolean }[] = [], limit = 50000): Promise<Row[]> {
  const out: Row[] = [];
  const chunk = 1000;
  for (let from = 0; from < limit; from += chunk) {
    let q = supabase.from(source).select('*');
    q = applyFilters(q, filters, target);
    for (const o of orderBy) q = q.order(o.column, { ascending: o.asc ?? true, nullsFirst: false });
    const { data, error } = await q.range(from, from + chunk - 1);
    if (error) throw error;
    const rows = (data as Row[]) ?? [];
    out.push(...rows);
    if (rows.length < chunk) break;
  }
  return out;
}

export async function searchRef(ref: RefDef, text: string, row: Row = {}, limit = 25): Promise<Row[]> {
  const valueCol = ref.valueColumn ?? 'id';
  const cols = Array.from(new Set([valueCol, ...ref.label, ...(ref.extra ?? [])])).join(',');
  let q = supabase.from(ref.table).select(cols);
  for (const [k, v] of Object.entries(ref.where ?? {})) q = q.eq(k, v);
  for (const [k, v] of Object.entries(ref.whereIn ?? {})) q = q.in(k, v as string[]);
  for (const k of ref.positive ?? []) q = q.gt(k, 0);
  if (ref.whereFrom) {
    for (const [k, v] of Object.entries(ref.whereFrom(row))) {
      if (v !== undefined && v !== null && v !== '') q = q.eq(k, v);
    }
  }
  const s = text.trim().replace(/[%_(),"]/g, ' ').trim();
  if (s) q = q.or((ref.search ?? ref.label).map((c) => `${c}.ilike.*${s}*`).join(','));
  if (ref.orderBy) q = q.order(ref.orderBy);
  const { data, error } = await q.limit(limit);
  if (error) throw error;
  return (data as unknown as Row[]) ?? [];
}

export async function refLabel(ref: RefDef, value: unknown): Promise<string> {
  if (value === null || value === undefined || value === '') return '';
  const valueCol = ref.valueColumn ?? 'id';
  const { data } = await supabase.from(ref.table).select(Array.from(new Set([valueCol, ...ref.label])).join(','))
    .eq(valueCol, value as string).maybeSingle();
  return data ? labelOf(ref, data as unknown as Row) : String(value);
}

export function labelOf(ref: RefDef, row: Row): string {
  return ref.label.map((c) => row[c]).filter((v) => v !== null && v !== undefined && v !== '').join(' · ');
}
