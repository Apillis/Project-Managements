import { describe, expect, it } from 'vitest';
import {
  colLetter, detectLayout, extractRows, matchHeaders, normUom, parseLeadTime, parseLevel, parseMoney,
  prepareBomTree, prepareEcountItems, unknownUoms, type Mapping,
} from '../lib/mappedImport';

// same aliases as supabase/migrations/20261015000013_reference_v11.sql
const BOM: Mapping[] = [
  ['level', ['level']], ['customer_part_no', ['customer part number', 'customer pn', 'customer p/n']],
  ['erp_code', ['ecount item code', 'erp code', 'item code']], ['description', ['description', 'item name']],
  ['customer_rev', ['customer rev', 'rev']], ['qty', ['bom.qty', 'bom qty', 'qty per', 'quantity', 'qty']], ['uom', ['unit', 'uom']],
  ['part_type', ['part type']], ['make_or_buy', ['procument type', 'procurement type', 'make or buy']],
  ['manufacturer', ['manufacturer', 'manufacture']], ['mpn', ['manufacturer part number', 'manufacturer part n', 'mpn']],
  ['find_no', ['bom.find num', 'find num', 'find no']], ['unit_cost', ['part unit cost', 'unit cost']], ['moq', ['moq qty', 'moq']],
  ['lead_time_days', ['lead time']], ['vendor_name', ['supplier name', 'vendor']], ['drawing_url', ['links', 'link', 'drawing']],
].map(([field, aliases], i) => ({ field: field as string, aliases: aliases as string[], sort: i + 1 }));

const HEADER = ['Level', 'Customer Part Number', 'Ecount Item Code', 'Description', 'Customer Rev', 'BOM.Qty', 'Unit', 'Part Type',
  'Procument Type', 'Manufacturer', 'Manufacturer Part Number', 'BOM.Find Num', 'Part Unit Cost ($)', 'MOQ Qty', 'Lead Time (weeks)',
  'Supplier Name', 'Links'];

describe('header matching', () => {
  it('maps the AZTAKD Structure BOM headers, exact before prefix', () => {
    const m = matchHeaders(HEADER, BOM);
    expect(m).toMatchObject({ level: 0, customer_part_no: 1, erp_code: 2, description: 3, customer_rev: 4, qty: 5, uom: 6, part_type: 7,
      make_or_buy: 8, manufacturer: 9, mpn: 10, find_no: 11, unit_cost: 12, moq: 13, lead_time_days: 14, vendor_name: 15, drawing_url: 16 });
  });
  it('ignores case, "*" and extra spaces; one column per field', () => {
    const m = matchHeaders(['  DESCRIPTION* ', 'Qty', 'qty per'], BOM);
    expect(m.description).toBe(0);
    expect(m.qty).toBe(2);   // exact "qty per" alias wins by sort order of aliases
  });
  it('detects the sheet and header row below a title block', () => {
    const sheets = [
      { name: 'Quote', rows: [['Quotation'], ['Customer', 'X']] },
      { name: 'Structure BOM', rows: [['AZTAKD610 REPEAT'], [], ['Printed', '2026-10-01'], HEADER, [0, 'TOP-1', '', 'ASSY', 'B', 1, 'EA']] },
    ];
    const d = detectLayout(sheets, BOM, ['description', 'qty'])!;
    expect([d.sheet, d.headerRow]).toEqual([1, 3]);
    const rows = extractRows(sheets[1], d.headerRow, d.map);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 0, customer_part_no: 'TOP-1', description: 'ASSY', __row: 5 });
  });
  it('column letters', () => {
    expect([colLetter(0), colLetter(25), colLetter(26), colLetter(27)]).toEqual(['A', 'Z', 'AA', 'AB']);
  });
});

describe('value parsing', () => {
  it('levels', () => {
    expect([parseLevel(0), parseLevel('2'), parseLevel('..2'), parseLevel('...'), parseLevel('Level 3'), parseLevel(''), parseLevel(1.5)])
      .toEqual([0, 2, 2, 3, 3, null, null]);
  });
  it('lead time in days', () => {
    expect([parseLeadTime(28), parseLeadTime('4 weeks'), parseLeadTime('3 wks'), parseLeadTime('10 days'), parseLeadTime('2 months'), parseLeadTime('n/a')])
      .toEqual([28, 28, 21, 10, 60, null]);
  });
  it('money', () => {
    expect([parseMoney('$1,234.50'), parseMoney('9.85'), parseMoney(0.08), parseMoney('')]).toEqual([1234.5, 9.85, 0.08, null]);
  });
  it('units like the database', () => {
    expect([normUom('each'), normUom('Meter'), normUom(' pc '), normUom('0'), normUom('kg')]).toEqual(['EA', 'M', 'PCS', null, 'KG']);
    expect(unknownUoms(['ea', 'meter', 'drum', 'Drum', null], ['EA', 'M'])).toEqual(['DRUM']);
  });
});

describe('structure BOM → import_bom_tree payload', () => {
  const rows = [
    { __row: 5, level: 0, customer_part_no: 'TOP', description: 'ASSY, CABLE', customer_rev: 'B', part_type: 'Cable Assy' },
    { __row: 6, level: 1, customer_part_no: 'C1', erp_code: '1001', description: 'CONN', qty: 16, uom: 'ea', part_type: 'OEM', make_or_buy: 'Buy', unit_cost: '$0.08', lead_time_days: '4 weeks' },
    { __row: 7, level: 1, erp_code: '1002', description: 'SUB ASSY', qty: '2', part_type: 'Sub-Assembly', make_or_buy: 'Make' },
    { __row: 8, level: 2, erp_code: '1003', description: 'SCREW', qty: 4, part_type: 'oem', make_or_buy: 'Customer Supplied' },
    { __row: 9, level: 2, erp_code: '0', description: 'WASHER', qty: 4 },
    { __row: 10, level: 1, description: 'LABEL', qty: 1 },
    { __row: 11 },
  ];
  it('builds keys and parent keys from the level column', () => {
    const p = prepareBomTree(rows, 'USD');
    expect(p.issues).toEqual([]);
    expect(p.top?.customer_part_no).toBe('TOP');
    expect(p.maxLevel).toBe(2);
    expect(p.rows.map((r) => [r.key, r.parent_key, r.level])).toEqual([
      ['r1', '', 0], ['r2', '', 1], ['r3', '', 1], ['r4', 'r3', 2], ['r5', 'r3', 2], ['r6', '', 1]]);
    expect(p.rows[1]).toMatchObject({ unit_cost: 0.08, lead_time_days: 28, part_type: 'oem', make_or_buy: 'buy', qty: 16, currency: 'USD' });
    expect(p.rows[2]).toMatchObject({ part_type: 'sub_assembly', make_or_buy: 'make', qty: 2 });
    expect(p.rows[3].make_or_buy).toBe('customer_supplied');
    expect(p.rows[4].erp_code).toBeUndefined();          // "0" = no ERP code
    expect(p.rows[0].part_type).toBe('cable_assy');
  });
  it('reports bad rows with their Excel row number', () => {
    const p = prepareBomTree([
      { __row: 2, level: 1, description: 'A', qty: 'x' },
      { __row: 3, level: 3, description: 'B', qty: 1 },
      { __row: 4, level: 1, description: 'C', qty: 1, part_type: 'banana' },
      { __row: 5, level: 0, description: 'T1' }, { __row: 6, level: 0, description: 'T2' },
      { __row: 7, level: 1, customer_part_no: 'X', qty: 1 },
    ]);
    const byRow = Object.fromEntries(p.issues.map((i) => [i.row, i.messages.join(' | ')]));
    expect(byRow[2]).toMatch(/qty/);
    expect(byRow[3]).toMatch(/level jumps/);
    expect(byRow[4]).toMatch(/part_type/);
    expect(byRow[6]).toMatch(/more than one level-0/);
    expect(byRow[7]).toMatch(/description/);
  });
  it('without a level column every row is level 1', () => {
    const p = prepareBomTree([{ description: 'A', qty: 2 }, { description: 'B', qty: 3 }]);
    expect(p.rows.map((r) => [r.level, r.parent_key])).toEqual([[1, ''], [1, '']]);
  });
});

describe('Ecount item list', () => {
  it('normalises items and prices, flags duplicates and missing codes', () => {
    const r = prepareEcountItems([
      { __row: 2, erp_code: '1001', name: 'CONN QC', mpn: '8-60894-1', uom: 'EA', unit_cost: '0.08', active: 'Yes', vendor_name: 'TE' },
      { __row: 3, erp_code: '1002', name: 'CABLE', spec: '2C 20AWG', uom: 'Meter', unit_cost: 0 },
      { __row: 4, erp_code: '1001', name: 'dup' },
      { __row: 5, erp_code: '0', name: 'no code' },
      { __row: 6 },
    ]);
    expect(r.items).toEqual([
      { erp_code: '1001', name: 'CONN QC', mpn: '8-60894-1', uom: 'EA', unit_cost: 0.08, is_active: true, vendor_name: 'TE' },
      { erp_code: '1002', name: 'CABLE', description: '2C 20AWG', uom: 'Meter' },
    ]);
    expect(r.issues.map((i) => i.row)).toEqual([4, 5]);
  });
});
