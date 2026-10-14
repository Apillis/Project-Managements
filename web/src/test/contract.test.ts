// Front-end ↔ database contract: every table, view and column the UI uses
// must exist in the migrated schema. Runs against the test database created by
// db-tests/reset-db.sh; skipped when no database is reachable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { E, REF, RESOURCES, SUB_LINES } from '../lib/resources';
import { normUom } from '../lib/mappedImport';
import { EXPORTS } from '../lib/exports';
import { IMPORTS } from '../lib/importer';
import type { RefDef } from '../lib/types';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pm_test';
let client: pg.Client | null = null;
const cols = new Map<string, Set<string>>();
const checks = new Map<string, string>();
const types = new Map<string, string>();

beforeAll(async () => {
  try {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    await c.connect();
    client = c;
    const r = await c.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public'`);
    for (const row of r.rows) {
      if (!cols.has(row.table_name)) cols.set(row.table_name, new Set());
      cols.get(row.table_name)!.add(row.column_name);
      types.set(`${row.table_name}.${row.column_name}`, row.data_type);
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

  it('reference pickers search only text columns (ilike)', () => {
    if (!client) return;
    const refs: RefDef[] = [...Object.values(REF),
      ...[...Object.values(RESOURCES).flatMap((r) => [...r.fields, ...(r.lines?.fields ?? [])]), ...Object.values(SUB_LINES).flatMap((l) => l.fields)]
        .filter((f) => f.ref).map((f) => f.ref!)];
    const bad = refs.flatMap((ref) => (ref.search ?? ref.label).map((c) => `${ref.table}.${c}`))
      .filter((k) => types.has(k) && !['text', 'character varying', 'character', 'USER-DEFINED'].includes(types.get(k)!));
    expect(Array.from(new Set(bad))).toEqual([]);
  });

  it('detail-page child tables (labour, fees, RFQ vendors) exist', () => {
    if (!client) return;
    const errs = Object.values(SUB_LINES).flatMap((l) => [
      ...missing(l.table, [...l.fields.map((f) => f.name), l.fk]),
      ...missing(l.view ?? l.table, [...l.columns.filter((c) => c.name !== 'vendor_name').map((c) => c.name), l.fk, l.orderBy]),
      ...l.fields.filter((f) => f.ref).flatMap((f) => missing(f.ref!.table, refColumns(f.ref!))),
    ]);
    errs.push(...missing('v_rfq_vendors', ['vendor_name', 'contact_email', 'rfq_id', ...SUB_LINES.VENDORS.columns.map((c) => c.name)]));
    errs.push(...missing('rfq_quotes', ['rfq_id', 'rfq_line_id', 'rfq_vendor_id', 'unit_price', 'currency_code', 'moq', 'lead_time_days', 'valid_until', 'notes']));
    errs.push(...missing('v_bom_tree', ['level', 'has_children', 'is_purchasable', 'item_id']));
    expect(errs).toEqual([]);
  });

  it('v1.1 enums match the database check constraints', () => {
    if (!client) return;
    const pairs: [string, readonly string[]][] = [
      ['items', E.partType], ['items', E.makeOrBuy], ['bom_lines', E.makeOrBuy], ['cost_rules', E.costBasis],
      ['labor_step_templates', E.laborDiscipline], ['item_prices', E.priceSource], ['uoms', E.uomCategory],
      ['cost_estimates', E.buildLocation], ['cost_estimates', E.estimateStatus], ['rfqs', E.rfqStatus],
    ];
    const errs = pairs.flatMap(([t, vals]) => vals.filter((v) => !(checks.get(t) ?? '').includes(`'${v}'`)).map((v) => `${t}: '${v}'`));
    expect(errs).toEqual([]);
  });

  it('import mappings target fields the importers understand', async () => {
    if (!client) return;
    const known: Record<string, string[]> = {
      structure_bom: ['level', 'customer_part_no', 'erp_code', 'description', 'customer_rev', 'qty', 'uom', 'part_type', 'make_or_buy',
        'manufacturer', 'mpn', 'find_no', 'unit_cost', 'moq', 'lead_time_days', 'vendor_name', 'drawing_url', 'position', 'notes'],
      ecount_items: ['erp_code', 'mpn', 'rev', 'name', 'spec', 'uom', 'vendor_name', 'unit_cost', 'category', 'active', 'drawing_url'],
    };
    const { rows } = await client.query(`select import_key, field from import_mappings`);
    const bad = rows.filter((r) => !(known[r.import_key] ?? []).includes(r.field)).map((r) => `${r.import_key}.${r.field}`);
    expect(bad).toEqual([]);
  });

  it('client unit normalisation equals app.norm_uom()', async () => {
    if (!client) return;
    const samples = ['each', 'Each', 'cái', 'pc', 'Pieces', 'meter', 'MÉT', 'feet', 'bộ', 'kg', ' m ', '0', '-', ''];
    const { rows } = await client.query(`select x, app.norm_uom(x) as u from unnest($1::text[]) x`, [samples]);
    expect(rows.map((r) => normUom(r.x))).toEqual(rows.map((r) => r.u));
  });
});
