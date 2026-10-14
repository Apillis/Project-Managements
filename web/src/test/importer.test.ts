import { describe, expect, it } from 'vitest';
import { IMPORTS, neededLookups, parseBool, parseDate, parseNumber, validateRows } from '../lib/importer';

describe('parsers', () => {
  it('parses booleans in VI/EN', () => {
    expect(['yes', 'Có', 'x', '1', true, 1].map(parseBool)).toEqual([true, true, true, true, true, true]);
    expect(['no', 'không', '0', '', false].map(parseBool)).toEqual([false, false, false, false, false]);
    expect(parseBool('maybe')).toBeNull();
  });
  it('parses VN/EU and US number formats', () => {
    expect(parseNumber('1.234.567,5')).toBe(1234567.5);
    expect(parseNumber('1,234,567.5')).toBe(1234567.5);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber(' 42 ')).toBe(42);
    expect(parseNumber('abc')).toBeNull();
  });
  it('parses ISO and dd/mm/yyyy dates', () => {
    expect(parseDate('2026-10-14')).toBe('2026-10-14');
    expect(parseDate('14/10/2026')).toBe('2026-10-14');
    expect(parseDate('1.2.2026')).toBe('2026-02-01');
    expect(parseDate('10-2026')).toBeNull();
  });
});

describe('validateRows', () => {
  it('validates partners: required, flags, duplicates, lookups', () => {
    const lookups = { currency: new Map([['eur', 'EUR'], ['vnd', 'VND']]) };
    const r = validateRows(IMPORTS.partners, [
      { code: 'C1', name: 'Acme', is_customer: 'yes', currency_code: 'eur', __row: 2 },
      { code: 'C2', name: 'NoFlag', __row: 3 },
      { code: 'c1', name: 'Dup', is_vendor: 'x', __row: 4 },
      { name: 'No code', is_vendor: 'maybe', currency_code: 'XXX', __row: 5 },
    ], lookups);
    expect(r.valid).toEqual([{ code: 'C1', name: 'Acme', is_customer: true, currency_code: 'EUR' }]);
    expect(r.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(r.errors[1].messages.join()).toMatch(/duplicate/);
    expect(r.errors[2].messages.join()).toMatch(/code: required/);
    expect(r.errors[2].messages.join()).toMatch(/not yes\/no/);
    expect(r.errors[2].messages.join()).toMatch(/"XXX" not found/);
  });

  it('builds opening stock moves with looked-up ids and a default note', () => {
    const lookups = { item: new Map([['sku-1', 'item-uuid']]), location: new Map([['a-01', 'loc-uuid']]), project: new Map() };
    const r = validateRows(IMPORTS.opening_stock, [{ sku: 'SKU-1', location_code: 'A-01', qty: '1.000,5', __row: 2 }], lookups);
    expect(r.errors).toEqual([]);
    expect(r.valid[0]).toEqual({ move_type: 'adjust', item_id: 'item-uuid', to_location_id: 'loc-uuid', qty: 1000.5, notes: 'Opening stock (import)' });
  });

  it('checks enums case-insensitively', () => {
    const r = validateRows(IMPORTS.bom_lines, [
      { description: 'Bolt', qty: 2, discipline: 'MECH', make_or_buy: 'Buy' },
      { qty: 1 },
      { description: 'x', qty: 1, discipline: 'magic' },
    ], { item: new Map() });
    expect(r.valid).toEqual([{ description: 'Bolt', qty: 2, discipline: 'mech', make_or_buy: 'buy' }]);
    expect(r.errors).toHaveLength(2);
  });

  it('lists the look-ups an import needs', () => {
    expect(neededLookups(IMPORTS.projects).sort()).toEqual(['partner', 'profile']);
    expect(neededLookups(IMPORTS.partners)).toEqual(['currency']);
  });
});
