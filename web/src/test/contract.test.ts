// Front-end ↔ database contract: every table, view and column the UI uses
// must exist in the migrated schema. Runs against the test database created by
// db-tests/reset-db.sh; skipped when no database is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { REF, RESOURCES } from '../lib/resources';
import { EXPORTS } from '../lib/exports';
import { IMPORTS } from '../lib/importer';
import type { RefDef } from '../lib/types';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pm_test';
let client: pg.Client | null = null;
const cols = new Map<string, Set<string>>();
const checks = new Map<string, string>();

beforeAll(async () => {
  try {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    await c.connect();
    client = c;
    const r = await c.query(`select table_name, column_name from information_schema.columns where table_schema = 'public'`);
    for (const row of r.rows) {
      if (!cols.has(row.table_name)) cols.set(row.table_name, new Set());
      cols.get(row.table_name)!.add(row.column_name);
    }
    const k = await c.query(`select conrelid::regclass::text as t, pg_get_constraintdef(oid) as def from pg_constraint
                              where contype = 'c' and connamespace = 'public'::regnamespace`);
    for (const row of k.rows) checks.set(row.t.replace(/^public\./, ''), (checks.get(row.t) ?? '') + ' ' + row.def);
  } catch {
    client = null;
  }
});
afterAll(async () => { await client?.end(); });

function has(table: string, column: string): boolean {
  return cols.get(table)?.has(column) ?? false;
}

function missing(table: string, columns: (string | undefined)[]): string[] {
  if (!cols.has(table)) return [`<table ${table} missing>`];
  return columns.filter((c): c is string => !!c && !has(table, c)).map((c) => `${table}.${c}`);
}

function refColumns(ref: RefDef): string[] {
  return [ref.valueColumn ?? 'id', ...ref.label, ...(ref.search ?? []), ...(ref.extra ?? []), ...Object.keys(ref.where ?? {}),
    ...Object.keys(ref.whereIn ?? {}), ...(ref.positive ?? []), ...(ref.orderBy ? [ref.orderBy] : [])];
}

describe.runIf(process.env.SKIP_DB !== '1')('UI ↔ database contract', () => {
  it('database is reachable (run db-tests/reset-db.sh first)', () => {
    if (!client) console.warn('contract test skipped: database not reachable at', url);
    expect(true).toBe(true);
  });

  it('resources: tables, views, fields, columns, filters', () => {
    if (!client) return;
    const errs: string[] = [];
    for (const r of Object.values(RESOURCES)) {
      const src = r.view ?? r.table;
      errs.push(...missing(r.table, r.fields.map((f) => f.name)));
      errs.push(...missing(src, [...r.columns.filter((c) => !c.render).map((c) => c.name), ...r.searchColumns,
        r.projectColumn, r.statusColumn, r.dateColumn, r.sort.column, 'id']));
      if (r.lines) {
        errs.push(...missing(r.lines.table, [...r.lines.fields.map((f) => f.name), r.lines.fk]));
        errs.push(...missing(r.lines.view ?? r.lines.table, [...r.lines.columns.filter((c) => c.name !== 'net_amount' || r.lines!.view).map((c) => c.name),
          r.lines.fk, r.lines.orderBy]));
      }
      for (const f of [...r.fields, ...(r.lines?.fields ?? [])]) if (f.ref) errs.push(...missing(f.ref.table, refColumns(f.ref)));
    }
    expect(errs).toEqual([]);
  });

  it('shared refs point to existing columns', () => {
    if (!client) return;
    const errs = Object.entries(REF).flatMap(([, ref]) => missing(ref.table, refColumns(ref)));
    expect(errs).toEqual([]);
  });

  it('status enums match the database check constraints', () => {
    if (!client) return;
    const errs: string[] = [];
    for (const r of Object.values(RESOURCES)) {
      if (!r.statusEnum || !r.statusColumn) continue;
      const def = checks.get(r.table) ?? '';
      for (const s of r.statusEnum) if (!def.includes(`'${s}'`)) errs.push(`${r.table}.${r.statusColumn}: '${s}'`);
    }
    expect(errs).toEqual([]);
  });

  it('fields editable after submission are whitelisted by the database guard', async () => {
    if (!client) return;
    const errs: string[] = [];
    for (const r of Object.values(RESOURCES)) {
      if (!r.openFields) continue;
      const { rows } = await client.query(
        `select encode(tgargs, 'escape') as args from pg_trigger where tgname = $1`, [`${r.table}_guard`]);
      const args = String(rows[0]?.args ?? '').split('\\000');
      const free = new Set(['status', 'notes', ...(args[1] ?? '').split(',')]);
      for (const f of r.openFields) if (!free.has(f)) errs.push(`${r.table}.${f}`);
    }
    expect(errs).toEqual([]);
  });

  it('export catalogue: sources and columns exist', () => {
    if (!client) return;
    const errs = EXPORTS.flatMap((e) => missing(e.source, [...e.columns.map((c) => c.key), e.projectColumn, e.dateColumn, e.statusColumn,
      ...(e.orderBy ?? []).map((o) => o.column)]));
    expect(errs).toEqual([]);
  });

  it('imports write existing columns', () => {
    if (!client) return;
    const errs = Object.values(IMPORTS).flatMap((d) => missing(d.table, [
      ...d.columns.filter((c) => c.kind !== 'lookup').map((c) => c.name), ...d.columns.filter((c) => c.target).map((c) => c.target),
      ...Object.keys(d.fixed ?? {}), d.conflict, d.needsBom ? 'bom_id' : undefined]));
    expect(errs).toEqual([]);
  });
});
