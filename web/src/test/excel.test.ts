import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildTemplate, buildWorkbook, cellValue, exportFileName, readSheet, safeSheetName, type SheetColumn } from '../lib/excel';

const labels = { filters: 'Filters', exportedBy: 'Exported by', total: 'Total', yes: 'Yes', no: 'No', rows: 'rows' };

async function roundTrip(wb: ExcelJS.Workbook) {
  const buf = await wb.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buf as ArrayBuffer);
  return back;
}

describe('excel export', () => {
  const cols: SheetColumn[] = [
    { key: 'doc_no', header: 'PO', type: 'text' },
    { key: 'order_date', header: 'Order date', type: 'date' },
    { key: 'net_amount', header: 'Net', type: 'money' },
    { key: 'qty', header: 'Qty', type: 'number' },
    { key: 'status', header: 'Status', type: 'status', format: (v) => `S:${v}` },
    { key: 'is_late', header: 'Late', type: 'bool' },
  ];
  const rows = [
    { doc_no: 'PO-2026-0001', order_date: '2026-10-01', net_amount: '1500000.50', qty: 3, status: 'approved', is_late: true },
    { doc_no: 'PO-2026-0002', order_date: '2026-10-02', net_amount: 200, qty: 1.5, status: 'draft', is_late: false },
  ];

  it('writes title, filters, header, typed rows and a SUBTOTAL row', async () => {
    const wb = buildWorkbook(cols, rows, { company: 'Apillis', title: 'PO lines', filters: 'Project: X', exportedBy: 'Truong', exportedAt: new Date('2026-10-14T08:00:00Z'), labels });
    const ws = (await roundTrip(wb)).worksheets[0];
    expect(ws.name).toBe('PO lines');
    expect(ws.getCell('A1').value).toBe('Apillis — PO lines');
    expect(String(ws.getCell('A2').value)).toContain('Project: X');
    expect(String(ws.getCell('A3').value)).toContain('Truong');
    expect(ws.getRow(5).values).toEqual([undefined, 'PO', 'Order date', 'Net', 'Qty', 'Status', 'Late']);
    expect(ws.getCell('C6').value).toBe(1500000.5);
    expect(ws.getCell('C6').numFmt).toBe('#,##0.00');
    expect((ws.getCell('B6').value as Date).toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(ws.getCell('E6').value).toBe('S:approved');
    expect(ws.getCell('F6').value).toBe('Yes');
    expect(ws.getCell('F7').value).toBe('No');
    expect(ws.getCell('A8').value).toBe('Total');
    expect((ws.getCell('C8').value as { formula: string }).formula).toBe('SUBTOTAL(9,C6:C7)');
    expect((ws.getCell('D8').value as { formula: string }).formula).toBe('SUBTOTAL(9,D6:D7)');
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 5 });
  });

  it('handles an empty result', async () => {
    const wb = buildWorkbook(cols, [], { company: 'A', title: 'Empty', filters: '', exportedBy: 'x', exportedAt: new Date(), labels });
    const ws = (await roundTrip(wb)).worksheets[0];
    expect(ws.getRow(5).getCell(1).value).toBe('PO');
    expect(ws.getCell('A6').value).toBeNull();
  });

  it('converts values per type', () => {
    expect(cellValue({ key: 'a', header: 'a', type: 'number' }, 'abc', labels)).toBeNull();
    expect(cellValue({ key: 'a', header: 'a' }, ['CE', 'UL'], labels)).toBe('CE, UL');
    expect(cellValue({ key: 'a', header: 'a', type: 'date' }, null, labels)).toBeNull();
    expect(cellValue({ key: 'a', header: 'a', type: 'percent' }, '12.5', labels)).toBe(12.5);
  });

  it('sanitises sheet and file names', () => {
    expect(safeSheetName('A/B:C*D?[x]')).toBe('A B C D  x ');
    expect(safeSheetName('x'.repeat(40))).toHaveLength(31);
    expect(exportFileName('po_lines', new Date(2026, 9, 14, 9, 5))).toBe('po_lines_20261014-0905.xlsx');
  });
});

describe('import template round trip', () => {
  it('reads back what the template contains', async () => {
    const wb = buildTemplate('items', ['sku', 'name', 'min_stock', 'start'], ['SKU-1', 'Sensor', 5, null], ['notes']);
    wb.worksheets[0].addRow(['SKU-2', ' Cable ', '3', new Date(Date.UTC(2026, 0, 2))]);
    wb.worksheets[0].addRow([]);
    const buf = await wb.xlsx.writeBuffer();
    const rows = await readSheet(buf as ArrayBuffer);
    expect(rows).toEqual([
      { sku: 'SKU-1', name: 'Sensor', min_stock: 5, __row: 2 },
      { sku: 'SKU-2', name: 'Cable', min_stock: '3', start: '2026-01-02', __row: 3 },
    ]);
  });
});

describe('readWorkbookRaw (imports with unknown layout)', () => {
  it('returns every sheet as a grid with plain values, URLs from link captions', async () => {
    const { readWorkbookRaw } = await import('../lib/excel');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Cover').addRow(['Quote']);
    const ws = wb.addWorksheet('Structure BOM');
    ws.addRow(['AZTAKD610']);
    ws.addRow([]);
    ws.addRow(['Level', 'Description', 'BOM.Qty', 'Links', 'Customer PN']);
    ws.addRow([1, { richText: [{ text: 'CONN ' }, { text: 'QC' }] }, { formula: '8*2', result: 16 },
      { text: 'Link', hyperlink: 'https://drive.example/d/1' }, { text: 'C-100', hyperlink: 'https://plm.example/C-100' }]);
    const buf = await wb.xlsx.writeBuffer();
    const sheets = await readWorkbookRaw(buf as ArrayBuffer);
    expect(sheets.map((s) => s.name)).toEqual(['Cover', 'Structure BOM']);
    expect(sheets[1].rows[1]).toEqual([]);
    expect(sheets[1].rows[3]).toEqual([1, 'CONN QC', 16, 'https://drive.example/d/1', 'C-100']);
  });
});
