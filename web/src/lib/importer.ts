// Excel import of legacy data: templates, parsing and validation. Pure logic,
// the page does the network calls (look-ups + upserts).
import { E } from './resources';

export type ImportKey = 'partners' | 'items' | 'projects' | 'bom_lines' | 'opening_stock';

export interface ImportColumn {
  name: string;
  required?: boolean;
  kind?: 'text' | 'number' | 'bool' | 'date' | 'enum' | 'lookup';
  options?: readonly string[];
  /** lookup map name; result written to `target` */
  lookup?: 'partner' | 'item' | 'profile' | 'location' | 'project' | 'currency';
  target?: string;
  example?: string | number | boolean;
}

export interface ImportDef {
  key: ImportKey;
  table: string;
  resource: string;
  conflict?: string;          // upsert key
  needsBom?: boolean;
  columns: ImportColumn[];
  /** fixed values merged into each payload */
  fixed?: Record<string, unknown>;
}

export const IMPORTS: Record<ImportKey, ImportDef> = {
  partners: {
    key: 'partners', table: 'partners', resource: 'partners', conflict: 'code',
    columns: [
      { name: 'code', required: true, example: 'C-ACME' },
      { name: 'name', required: true, example: 'ACME GmbH' },
      { name: 'is_customer', kind: 'bool', example: 'yes' },
      { name: 'is_vendor', kind: 'bool', example: 'no' },
      { name: 'is_carrier', kind: 'bool', example: 'no' },
      { name: 'tax_code', example: '0101234567' },
      { name: 'country', example: 'DE' },
      { name: 'address' }, { name: 'contact_name' }, { name: 'email' }, { name: 'phone' },
      { name: 'currency_code', kind: 'lookup', lookup: 'currency', target: 'currency_code', example: 'EUR' },
      { name: 'payment_terms', example: '30 days' }, { name: 'incoterm', example: 'EXW' }, { name: 'notes' },
    ],
  },
  items: {
    key: 'items', table: 'items', resource: 'items', conflict: 'sku',
    columns: [
      { name: 'sku', required: true, example: 'FESTO-DSBC-32-100' },
      { name: 'name', required: true, example: 'Cylinder DSBC-32-100-PPVA-N3' },
      { name: 'manufacturer', example: 'Festo' }, { name: 'mpn', example: '1376425' }, { name: 'category', example: 'Pneumatic' },
      { name: 'item_type', kind: 'enum', options: E.itemType, example: 'part' },
      { name: 'uom', example: 'pcs' },
      { name: 'is_stocked', kind: 'bool', example: 'yes' }, { name: 'track_lot', kind: 'bool' }, { name: 'track_serial', kind: 'bool' },
      { name: 'min_stock', kind: 'number', example: 2 }, { name: 'lead_time_days', kind: 'number', example: 14 },
      { name: 'default_vendor_code', kind: 'lookup', lookup: 'partner', target: 'default_vendor_id' },
      { name: 'hs_code' }, { name: 'country_of_origin' }, { name: 'description' },
    ],
  },
  projects: {
    key: 'projects', table: 'projects', resource: 'projects', conflict: 'code',
    columns: [
      { name: 'code', required: true, example: 'IPGOJE601' },
      { name: 'name', required: true, example: 'Pneumatic panel for laser cutter' },
      { name: 'customer_code', kind: 'lookup', lookup: 'partner', target: 'customer_id', example: 'C-ACME' },
      { name: 'market', kind: 'enum', options: E.market, example: 'EU' },
      { name: 'start_date', kind: 'date', example: '2026-10-01' }, { name: 'due_date', kind: 'date', example: '2026-12-15' },
      { name: 'status', kind: 'enum', options: E.projectStatus, example: 'active' },
      { name: 'pm_email', kind: 'lookup', lookup: 'profile', target: 'pm_id' },
      { name: 'description' },
    ],
  },
  bom_lines: {
    key: 'bom_lines', table: 'bom_lines', resource: 'bom', needsBom: true,
    columns: [
      { name: 'sku', kind: 'lookup', lookup: 'item', target: 'item_id', example: 'FESTO-DSBC-32-100' },
      { name: 'description', example: 'Cylinder DSBC-32-100' },
      { name: 'manufacturer' }, { name: 'mpn' },
      { name: 'qty', required: true, kind: 'number', example: 4 },
      { name: 'uom', example: 'pcs' }, { name: 'position', example: '=A1-MB1' },
      { name: 'discipline', kind: 'enum', options: E.discipline, example: 'pneu' },
      { name: 'make_or_buy', kind: 'enum', options: E.makeOrBuy, example: 'buy' },
      { name: 'notes' },
    ],
  },
  opening_stock: {
    key: 'opening_stock', table: 'stock_moves', resource: 'warehouse', fixed: { move_type: 'adjust' },
    columns: [
      { name: 'sku', required: true, kind: 'lookup', lookup: 'item', target: 'item_id', example: 'FESTO-DSBC-32-100' },
      { name: 'location_code', required: true, kind: 'lookup', lookup: 'location', target: 'to_location_id', example: 'A-01' },
      { name: 'qty', required: true, kind: 'number', example: 10 },
      { name: 'lot_no' }, { name: 'serial_no' },
      { name: 'project_code', kind: 'lookup', lookup: 'project', target: 'project_id' },
      { name: 'notes', example: 'Opening stock 2026' },
    ],
  },
};

export type Lookups = Partial<Record<NonNullable<ImportColumn['lookup']>, Map<string, string>>>;

export interface RowError { row: number; messages: string[] }
export interface ValidationResult { valid: Record<string, unknown>[]; errors: RowError[] }

const TRUE = ['1', 'x', 'y', 'yes', 'true', 'có', 'co', 'c'];
const FALSE = ['0', '', 'n', 'no', 'false', 'không', 'khong', 'k'];

export function parseBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v ?? '').trim().toLowerCase();
  if (TRUE.includes(s)) return true;
  if (FALSE.includes(s)) return false;
  return null;
}

export function parseNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/\s/g, '');
  if (s === '') return null;
  // accept 1.234,5 (VN/EU) and 1,234.5 (US)
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function parseDate(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);   // dd/mm/yyyy
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

export function validateRows(def: ImportDef, rows: Record<string, unknown>[], lookups: Lookups): ValidationResult {
  const valid: Record<string, unknown>[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, idx) => {
    const rowNo = Number(raw.__row ?? idx + 2);
    const msgs: string[] = [];
    const out: Record<string, unknown> = { ...(def.fixed ?? {}) };
    for (const col of def.columns) {
      const v = raw[col.name];
      const empty = v === undefined || v === null || String(v).trim() === '';
      if (empty) {
        if (col.required) msgs.push(`${col.name}: required`);
        continue;
      }
      switch (col.kind ?? 'text') {
        case 'bool': {
          const b = parseBool(v);
          if (b === null) msgs.push(`${col.name}: "${v}" is not yes/no`); else out[col.name] = b;
          break;
        }
        case 'number': {
          const n = parseNumber(v);
          if (n === null) msgs.push(`${col.name}: "${v}" is not a number`); else out[col.name] = n;
          break;
        }
        case 'date': {
          const d = parseDate(v);
          if (d === null) msgs.push(`${col.name}: "${v}" is not a date (yyyy-mm-dd or dd/mm/yyyy)`); else out[col.name] = d;
          break;
        }
        case 'enum': {
          const s = String(v).trim().toLowerCase();
          const opt = col.options?.find((o) => o.toLowerCase() === s);
          if (!opt) msgs.push(`${col.name}: "${v}" must be one of ${col.options?.join(', ')}`); else out[col.name] = opt;
          break;
        }
        case 'lookup': {
          const key = String(v).trim().toLowerCase();
          const id = lookups[col.lookup!]?.get(key);
          if (!id) msgs.push(`${col.name}: "${v}" not found`); else out[col.target ?? col.name] = id;
          break;
        }
        default:
          out[col.name] = String(v).trim();
      }
    }
    if (def.key === 'partners' && !out.is_customer && !out.is_vendor && !out.is_carrier) {
      msgs.push('is_customer / is_vendor / is_carrier: at least one must be yes');
    }
    if (def.key === 'bom_lines' && !out.item_id && !out.description) {
      msgs.push('description: required when sku is empty');
    }
    if (def.key === 'opening_stock' && !out.notes) out.notes = 'Opening stock (import)';
    if (def.conflict) {
      const k = String(out[def.conflict] ?? '').toLowerCase();
      if (k && seen.has(k)) msgs.push(`${def.conflict}: duplicate "${out[def.conflict]}" in file`);
      seen.add(k);
    }
    if (msgs.length) errors.push({ row: rowNo, messages: msgs });
    else valid.push(out);
  });
  return { valid, errors };
}

/** Which look-up maps an import needs */
export function neededLookups(def: ImportDef): NonNullable<ImportColumn['lookup']>[] {
  return Array.from(new Set(def.columns.filter((c) => c.lookup).map((c) => c.lookup!)));
}
