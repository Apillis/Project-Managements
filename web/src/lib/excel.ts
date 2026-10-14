// Excel (.xlsx) builder shared by every export. Runs in the browser.
import ExcelJS from 'exceljs';
import type { XType } from './exports';

export interface SheetColumn {
  key: string;
  header: string;
  type?: XType;
  width?: number;
  /** translate enum/status values */
  format?: (value: unknown) => string;
}

export interface WorkbookMeta {
  company: string;
  title: string;
  filters: string;
  exportedBy: string;
  exportedAt: Date;
  labels: { filters: string; exportedBy: string; total: string; yes: string; no: string; rows: string };
  sheetName?: string;
}

const HEADER_ROW = 5;
const BRAND = 'FF0F4C81';

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return v;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Convert a raw value into what is written in the cell. Exported for tests. */
export function cellValue(col: SheetColumn, v: unknown, labels: WorkbookMeta['labels']): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  switch (col.type) {
    case 'number':
    case 'money':
    case 'percent': {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case 'date':
    case 'datetime':
      return toDate(v);
    case 'bool':
      return v ? labels.yes : labels.no;
    case 'status':
    case 'enum':
      return col.format ? col.format(v) : String(v);
    default:
      if (Array.isArray(v)) return v.join(', ');
      if (typeof v === 'object') return JSON.stringify(v);
      return col.format ? col.format(v) : String(v);
  }
}

function numFmt(type?: XType): string | undefined {
  switch (type) {
    case 'money': return '#,##0.00';
    case 'number': return '#,##0.####';
    case 'percent': return '0.0"%"';
    case 'date': return 'yyyy-mm-dd';
    case 'datetime': return 'yyyy-mm-dd hh:mm';
    default: return undefined;
  }
}

function colLetter(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function safeSheetName(name: string): string {
  return name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
}

export function buildWorkbook(columns: SheetColumn[], rows: Record<string, unknown>[], meta: WorkbookMeta): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = meta.exportedBy;
  wb.created = meta.exportedAt;
  wb.title = meta.title;
  const ws = wb.addWorksheet(safeSheetName(meta.sheetName ?? meta.title), {
    views: [{ state: 'frozen', ySplit: HEADER_ROW, xSplit: 0 }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });

  const lastCol = colLetter(Math.max(columns.length, 1));
  ws.getCell('A1').value = `${meta.company} — ${meta.title}`;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: BRAND } };
  ws.getCell('A2').value = `${meta.labels.filters}: ${meta.filters || '—'}`;
  ws.getCell('A3').value = `${meta.labels.exportedBy}: ${meta.exportedBy} · ${meta.exportedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC · ${rows.length} ${meta.labels.rows}`;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF555555' } };
  ws.getCell('A3').font = { italic: true, color: { argb: 'FF555555' } };

  const header = ws.getRow(HEADER_ROW);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF999999' } } };
  });
  header.height = 30;

  rows.forEach((r, ri) => {
    const row = ws.getRow(HEADER_ROW + 1 + ri);
    columns.forEach((c, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = cellValue(c, r[c.key], meta.labels);
      const fmt = numFmt(c.type);
      if (fmt) cell.numFmt = fmt;
    });
    if (ri % 2 === 1) {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6FA' } };
      });
    }
  });

  // widths: explicit or from content
  columns.forEach((c, i) => {
    let w = c.width ?? Math.max(c.header.length + 2, 8);
    if (!c.width) {
      for (const r of rows.slice(0, 300)) {
        const v = cellValue(c, r[c.key], meta.labels);
        const len = v instanceof Date ? 16 : v === null ? 0 : String(v).length;
        w = Math.max(w, Math.min(len + 2, 50));
      }
    }
    ws.getColumn(i + 1).width = w;
  });

  const firstData = HEADER_ROW + 1;
  const lastData = HEADER_ROW + rows.length;
  if (rows.length > 0) {
    ws.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: columns.length } };
    // SUBTOTAL keeps working when the user filters the table in Excel
    const sumCols = columns.map((c, i) => ({ c, i })).filter(({ c }) => c.type === 'money' || (c.type === 'number' && /qty|hours|amount|cost|count|lines/.test(c.key)));
    if (sumCols.length) {
      const totalRow = ws.getRow(lastData + 1);
      totalRow.getCell(1).value = meta.labels.total;
      totalRow.getCell(1).font = { bold: true };
      for (const { c, i } of sumCols) {
        if (i === 0) continue;
        const L = colLetter(i + 1);
        const cell = totalRow.getCell(i + 1);
        cell.value = { formula: `SUBTOTAL(9,${L}${firstData}:${L}${lastData})` };
        cell.numFmt = numFmt(c.type) ?? '#,##0.##';
        cell.font = { bold: true };
        cell.border = { top: { style: 'thin' } };
      }
    }
  }
  if (columns.length > 1) ws.mergeCells(`A1:${lastCol}1`);
  return wb;
}

export function exportFileName(key: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${key}_${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.xlsx`;
}

export async function downloadWorkbook(wb: ExcelJS.Workbook, fileName: string): Promise<void> {
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Template workbook for imports: one header row + an example row + a notes sheet. */
export function buildTemplate(sheet: string, headers: string[], example: (string | number | boolean | null)[], notes: string[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeSheetName(sheet));
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(1).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } }; });
  ws.addRow(example);
  headers.forEach((h, i) => { ws.getColumn(i + 1).width = Math.max(h.length + 4, 14); });
  const info = wb.addWorksheet('README');
  notes.forEach((n) => info.addRow([n]));
  info.getColumn(1).width = 120;
  return wb;
}

/** Read the first worksheet into objects keyed by the header row. */
export async function readSheet(data: ArrayBuffer): Promise<Record<string, unknown>[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col] = String(cell.value ?? '').trim();
  });
  const out: Record<string, unknown>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn === 1) return;
    const obj: Record<string, unknown> = {};
    let any = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const h = headers[col];
      if (!h) return;
      let v: unknown = cell.value;
      if (v && typeof v === 'object') {
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if ('result' in (v as object)) v = (v as { result: unknown }).result;
        else if ('text' in (v as object)) v = (v as { text: unknown }).text;
        else if ('richText' in (v as object)) v = (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
      }
      if (v !== null && v !== undefined && String(v).trim() !== '') any = true;
      obj[h] = typeof v === 'string' ? v.trim() : v;
    });
    if (any) { obj.__row = rn; out.push(obj); }
  });
  return out;
}

function plainCell(v: unknown): unknown {
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const o = v as Record<string, unknown>;
    if ('result' in o) return plainCell(o.result);
    if ('hyperlink' in o && typeof o.hyperlink === 'string' && /^https?:/i.test(o.hyperlink)) {
      // "Link" / "Drawing" captions → the URL itself; a linked part number keeps its text
      const text = String(plainCell(o.text) ?? '').trim();
      return !text || /^https?:/i.test(text) || /^(link|links|drawing|view|open|pdf|here)$/i.test(text) ? o.hyperlink : text;
    }
    if ('richText' in o) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if ('text' in o) return plainCell(o.text);
    if ('error' in o) return null;
  }
  return typeof v === 'string' ? v.trim() : v;
}

/** Every worksheet as a raw grid (0-based rows/cols), for imports with unknown layout. */
export async function readWorkbookRaw(data: ArrayBuffer, maxRows = 20000): Promise<{ name: string; rows: unknown[][] }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  return wb.worksheets.map((ws) => {
    const rows: unknown[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, rn) => {
      if (rn > maxRows) return;
      const r: unknown[] = [];
      row.eachCell({ includeEmpty: false }, (cell, col) => { r[col - 1] = plainCell(cell.value); });
      rows[rn - 1] = r;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return { name: ws.name, rows };
  });
}
