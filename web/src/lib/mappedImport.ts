// Import of customer / ERP Excel files whose layout we do not control
// (Structure BOM exported from the customer's PLM, Ecount item list).
// Column headers are matched against aliases kept in the `import_mappings`
// table (Settings → Import mapping), the sheet and header row are detected,
// and the rows are normalised for the `import_bom_tree` RPC / items upsert.
// Pure logic: no React, no Supabase.
import { E } from './resources';
import { parseBool, parseNumber } from './importer';

export type MappedImportKey = 'structure_bom' | 'ecount_items';

export interface Mapping { field: string; aliases: string[]; sort?: number }
export type ColumnMap = Record<string, number>;          // field → 0-based column index
export interface RawSheet { name: string; rows: unknown[][] }
export interface Detection { sheet: number; headerRow: number; map: ColumnMap; headers: string[]; score: number }

/** Lower-case, drop "*", "#", punctuation at the ends, collapse spaces. */
export function normHeader(v: unknown): string {
  return String(v ?? '').toLowerCase().replace(/[*#:]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Match one header row against the mappings. Exact matches win over prefix
 * matches ("Manufacturer Part Number" must not be taken by "manufacturer"),
 * longer aliases win over shorter ones, and every column is used once.
 */
export function matchHeaders(headerRow: unknown[], mappings: Mapping[]): ColumnMap {
  const headers = headerRow.map(normHeader);
  const out: ColumnMap = {};
  const used = new Set<number>();
  const take = (field: string, idx: number) => { out[field] = idx; used.add(idx); };
  const sorted = [...mappings].sort((a, b) => (a.sort ?? 100) - (b.sort ?? 100));
  // pass 1: exact
  for (const m of sorted) {
    for (const a of m.aliases.map(normHeader)) {
      const idx = headers.findIndex((h, i) => h && h === a && !used.has(i));
      if (idx >= 0 && !(m.field in out)) { take(m.field, idx); break; }
    }
  }
  // pass 2: header starts with alias, longest alias first
  const cands = sorted.filter((m) => !(m.field in out))
    .flatMap((m) => m.aliases.map((a) => ({ field: m.field, alias: normHeader(a) })))
    .filter((c) => c.alias.length >= 3)
    .sort((x, y) => y.alias.length - x.alias.length);
  for (const c of cands) {
    if (c.field in out) continue;
    const idx = headers.findIndex((h, i) => h && !used.has(i) && h.startsWith(c.alias));
    if (idx >= 0) take(c.field, idx);
  }
  return out;
}

/** Find the sheet + header row with the most matched fields (first 30 rows of each sheet). */
export function detectLayout(sheets: RawSheet[], mappings: Mapping[], required: string[] = []): Detection | null {
  let best: Detection | null = null;
  sheets.forEach((s, si) => {
    const limit = Math.min(s.rows.length, 30);
    for (let r = 0; r < limit; r++) {
      const row = s.rows[r] ?? [];
      const map = matchHeaders(row, mappings);
      const n = Object.keys(map).length;
      const score = n + required.filter((f) => f in map).length * 2;
      if (n >= 2 && (!best || score > best.score)) {
        best = { sheet: si, headerRow: r, map, headers: row.map((h) => String(h ?? '').trim()), score };
      }
    }
  });
  return best;
}

/** Rows below the header as objects keyed by mapped field. Empty rows are skipped. */
export function extractRows(sheet: RawSheet, headerRow: number, map: ColumnMap): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r] ?? [];
    const obj: Record<string, unknown> = { __row: r + 1 };
    let any = false;
    for (const [field, idx] of Object.entries(map)) {
      let v = row[idx];
      if (typeof v === 'string') v = v.trim();
      if (v !== null && v !== undefined && v !== '') { obj[field] = v; any = true; }
    }
    if (any) out.push(obj);
  }
  return out;
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v).trim());

/** "0", 1, ".1", "..2", "Level 3" → number; null when not a level. */
export function parseLevel(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : null;
  const s = str(v);
  if (!s) return null;
  const dots = s.match(/^(\.+)\s*(\d+)?$/);
  if (dots) return dots[2] !== undefined ? Number(dots[2]) : dots[1].length;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const PART_TYPE_ALIASES: Record<string, string> = {
  oem: 'oem', 'purchased': 'oem', 'commercial': 'oem', cots: 'oem', 'off the shelf': 'oem',
  fabricated: 'fabricated', fab: 'fabricated', machined: 'fabricated', 'sheet metal': 'fabricated',
  'cable assy': 'cable_assy', 'cable assembly': 'cable_assy', cable: 'cable_assy', harness: 'cable_assy', 'wire harness': 'cable_assy',
  pcba: 'pcba', pcb: 'pcba', 'pcb assembly': 'pcba',
  'sub assembly': 'sub_assembly', 'sub-assembly': 'sub_assembly', subassembly: 'sub_assembly', assembly: 'sub_assembly', assy: 'sub_assembly',
  'raw material': 'raw_material', raw: 'raw_material', 'sub material': 'sub_material', 'sub-material': 'sub_material',
  consumable: 'consumable', consumables: 'consumable', 'finished goods': 'finished_goods', fg: 'finished_goods',
  service: 'service', intangible: 'intangible', document: 'intangible', label: 'oem',
};
const MAKE_BUY_ALIASES: Record<string, string> = {
  buy: 'buy', purchase: 'buy', purchased: 'buy', make: 'make', manufacture: 'make', 'in house': 'make', 'in-house': 'make',
  stock: 'stock', 'from stock': 'stock', 'customer supplied': 'customer_supplied', consigned: 'customer_supplied', 'customer furnished': 'customer_supplied',
  cfm: 'customer_supplied', subcontract: 'subcontract', outsource: 'subcontract', 'outside process': 'subcontract',
};

function mapEnum(v: unknown, aliases: Record<string, string>, options: readonly string[]): string | null | undefined {
  const s = normHeader(v).replace(/_/g, ' ');
  if (!s) return undefined;
  const direct = options.find((o) => o.replace(/_/g, ' ') === s);
  if (direct) return direct;
  return aliases[s] ?? null;
}

/** "4 weeks", "28", "3 wks", "10 days" → days */
export function parseLeadTime(v: unknown): number | null {
  if (typeof v === 'number') return Math.round(v);
  const s = str(v).toLowerCase();
  if (!s) return null;
  const n = parseNumber(s.replace(/[^\d.,-]/g, ' ').trim().split(/\s+/)[0]);
  if (n === null) return null;
  if (/w(ee)?k/.test(s)) return Math.round(n * 7);
  if (/month|mo\b/.test(s)) return Math.round(n * 30);
  return Math.round(n);
}

/** "$1,234.50", "1.234,5 €" → number */
export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number') return v;
  const s = str(v).replace(/[^\d.,-]/g, '');
  return s ? parseNumber(s) : null;
}

export interface TreeRow {
  key: string; parent_key: string; level: number;
  [field: string]: unknown;
}
export interface RowIssue { row: number; messages: string[] }
export interface BomPrepared { rows: TreeRow[]; issues: RowIssue[]; top: TreeRow | null; maxLevel: number }

/**
 * Turn extracted Structure-BOM rows into the payload of `import_bom_tree`:
 * keys/parent keys from the Level column (nearest previous row with a lower level).
 * Without a Level column every row is level 1.
 */
export function prepareBomTree(rows: Record<string, unknown>[], currency = 'USD'): BomPrepared {
  const out: TreeRow[] = [];
  const issues: RowIssue[] = [];
  const stack: { level: number; key: string }[] = [];
  let top: TreeRow | null = null;
  let maxLevel = 0;
  rows.forEach((raw, i) => {
    const rowNo = Number(raw.__row ?? i + 2);
    const msgs: string[] = [];
    const hasLevelCol = 'level' in raw;
    let level = hasLevelCol ? parseLevel(raw.level) : 1;
    if (level === null) { msgs.push(`level: "${str(raw.level)}" is not a number`); level = 1; }
    const description = str(raw.description);
    const ids = [raw.customer_part_no, raw.erp_code, raw.mpn].map(str).filter(Boolean);
    if (!description && !ids.length) return;              // section/blank row
    if (!description) msgs.push('description: required');
    const key = 'r' + (i + 1);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parentKey = level <= 1 ? '' : (stack.length ? stack[stack.length - 1].key : '');
    if (level > 1 && !parentKey) msgs.push(`level ${level}: no parent row above`);
    if (stack.length && level > stack[stack.length - 1].level + 1) msgs.push(`level jumps from ${stack[stack.length - 1].level} to ${level}`);
    const t: TreeRow = { key, parent_key: parentKey, level, description, currency, __row: rowNo };
    for (const f of ['customer_part_no', 'customer_rev', 'erp_code', 'manufacturer', 'mpn', 'find_no', 'vendor_name', 'drawing_url', 'position', 'notes']) {
      const v = str(raw[f]);
      if (v && !(f === 'erp_code' && v === '0')) t[f] = v;
    }
    const uom = str(raw.uom); if (uom) t.uom = uom;
    if (raw.qty !== undefined) {
      const q = parseNumber(raw.qty);
      if (q === null || q < 0) msgs.push(`qty: "${str(raw.qty)}" is not a number`); else t.qty = q;
    } else if (level > 0) t.qty = 1;
    if (level > 0 && t.qty === 0) msgs.push('qty: must be > 0');
    const pt = mapEnum(raw.part_type, PART_TYPE_ALIASES, E.partType);
    if (pt === null) msgs.push(`part_type: "${str(raw.part_type)}" unknown (${E.partType.join(', ')})`); else if (pt) t.part_type = pt;
    const mb = mapEnum(raw.make_or_buy, MAKE_BUY_ALIASES, E.makeOrBuy);
    if (mb === null) msgs.push(`make_or_buy: "${str(raw.make_or_buy)}" unknown (${E.makeOrBuy.join(', ')})`); else if (mb) t.make_or_buy = mb;
    for (const f of ['unit_cost', 'moq'] as const) {
      if (raw[f] === undefined) continue;
      const n = parseMoney(raw[f]);
      if (n === null || n < 0) msgs.push(`${f}: "${str(raw[f])}" is not a number`); else t[f] = n;
    }
    if (raw.lead_time_days !== undefined) {
      const d = parseLeadTime(raw.lead_time_days);
      if (d === null) msgs.push(`lead_time: "${str(raw.lead_time_days)}" is not a number`); else t.lead_time_days = d;
    }
    if (level === 0) {
      if (top) msgs.push('more than one level-0 (top assembly) row');
      else top = t;
    }
    maxLevel = Math.max(maxLevel, level);
    if (msgs.length) issues.push({ row: rowNo, messages: msgs });
    out.push(t);
    stack.push({ level, key });
  });
  return { rows: out, issues, top, maxLevel };
}

export interface EcountItem {
  erp_code: string; name: string; mpn?: string; description?: string; uom?: string; category?: string;
  is_active?: boolean; drawing_url?: string; vendor_name?: string; unit_cost?: number; rev?: string;
}

/** Ecount item list → item payloads (by ERP code) + optional purchase prices. */
export function prepareEcountItems(rows: Record<string, unknown>[]): { items: EcountItem[]; issues: RowIssue[] } {
  const items: EcountItem[] = [];
  const issues: RowIssue[] = [];
  const seen = new Set<string>();
  rows.forEach((raw, i) => {
    const rowNo = Number(raw.__row ?? i + 2);
    const msgs: string[] = [];
    const erp = str(raw.erp_code);
    const name = str(raw.name);
    if (!erp && !name) return;
    if (!erp || erp === '0') msgs.push('item code: required');
    if (!name) msgs.push('item name: required');
    if (erp && seen.has(erp.toLowerCase())) msgs.push(`item code "${erp}" repeated in file`);
    seen.add(erp.toLowerCase());
    const it: EcountItem = { erp_code: erp, name };
    const mpn = str(raw.mpn); if (mpn) it.mpn = mpn;
    const spec = str(raw.spec); if (spec) it.description = spec;
    const uom = str(raw.uom); if (uom) it.uom = uom;
    const cat = str(raw.category); if (cat) it.category = cat;
    const link = str(raw.drawing_url); if (link) it.drawing_url = link;
    const vendor = str(raw.vendor_name); if (vendor) it.vendor_name = vendor;
    const rev = str(raw.rev); if (rev) it.rev = rev;
    if (raw.active !== undefined) {
      const b = parseBool(raw.active);
      if (b === null) msgs.push(`active: "${str(raw.active)}" is not yes/no`); else it.is_active = b;
    }
    if (raw.unit_cost !== undefined) {
      const n = parseMoney(raw.unit_cost);
      if (n === null || n < 0) msgs.push(`purchase price: "${str(raw.unit_cost)}" is not a number`); else if (n > 0) it.unit_cost = n;
    }
    if (msgs.length) issues.push({ row: rowNo, messages: msgs }); else items.push(it);
  });
  return { items, issues };
}

/** Column letters for the mapping editor (0 → A, 26 → AA). */
export function colLetter(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** Same normalisation as app.norm_uom() in the database. */
export function normUom(p: unknown): string | null {
  const s = str(p);
  if (!s || s === '0' || s === '-') return null;
  const u = s.toUpperCase();
  if (['EACH', 'CÁI', 'CAI'].includes(u)) return 'EA';
  if (['PC', 'PIECE', 'PIECES', 'CHIẾC', 'CHIEC'].includes(u)) return 'PCS';
  if (['METER', 'METRE', 'MET', 'MÉT'].includes(u)) return 'M';
  if (['FEET', 'FOOT'].includes(u)) return 'FT';
  if (['BỘ', 'BO', 'SETS'].includes(u)) return 'SET';
  return u;
}

/** Units used by the rows that are not in the unit master. */
export function unknownUoms(values: unknown[], known: Iterable<string>): string[] {
  const k = new Set(Array.from(known, (x) => x.toUpperCase()));
  return Array.from(new Set(values.map(normUom).filter((u): u is string => !!u && !k.has(u)))).sort();
}
