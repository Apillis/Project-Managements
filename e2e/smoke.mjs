// End-to-end smoke test of the real app against GoTrue + PostgREST + PostgreSQL
// (start the stack first: bash stack.sh up). Walks the main life-cycle:
// sign-up → IDEF0 plan → BOM → approval → PR → PO → receiving → stock → Excel export,
// v1.1: Structure-BOM import (multi-level) → net requirement → cost estimate (A–L)
// → quotation → RFQ (send, quote, award, POs) → Ecount item import.
import { chromium } from 'playwright';
import ExcelJS from 'exceljs';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const BASE = process.env.E2E_URL ?? 'http://localhost:4173';
const OUT = new URL('./artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, locale: 'vi-VN' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason || {};
    console.error('UNHANDLED ' + JSON.stringify({ message: r.message, code: r.code, details: r.details, hint: r.hint, stack: String(r.stack || '').slice(0, 300) }));
  });
});
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.message} ${JSON.stringify(e)} @ ${page.url()}`));
page.on('console', async (m) => {
  if (m.type() !== 'error') return;
  let text = m.text();
  try { text += ' ' + JSON.stringify(await Promise.all(m.args().map((a) => a.jsonValue()))); } catch { /* ignore */ }
  if (!/realtime|websocket|WebSocket|Failed to load resource/i.test(text)) errors.push(`${text} @ ${m.location().url}:${m.location().lineNumber}`);
});

let step = 0;
async function shot(name) { await page.screenshot({ path: `${OUT}${String(++step).padStart(2, '0')}-${name}.png`, fullPage: false }); }
async function toast(re) { await page.locator('.toast').filter({ hasText: re }).first().waitFor({ timeout: 10000 }); }
function log(s) { console.log('✓', s); }
async function pickRef(labelText, search, optionText, scope = page) {
  const field = scope.locator('label.field').filter({ hasText: labelText }).first();
  const input = field.locator('.ref input').first();
  await input.click();
  await input.fill(search);
  const opt = field.locator('.ref .menu div').filter({ hasText: optionText }).first();
  await opt.waitFor({ timeout: 10000 });
  await opt.dispatchEvent('mousedown');
}

try {
  // ------------------------------------------------------------ sign up (first user = admin)
  await page.goto(BASE);
  await page.getByText('Đăng ký', { exact: true }).click();
  await page.locator('label.field', { hasText: 'Họ tên' }).locator('input').fill('Trương Admin');
  await page.locator('input[type=email]').fill('truong@apillis.com');
  await page.locator('input[type=password]').fill('Apillis#2026');
  await page.locator('form button.primary').click();
  await page.getByText('Xin chào Trương Admin').waitFor({ timeout: 15000 });
  await shot('dashboard-vi');
  log('signed up, first user is admin, dashboard in Vietnamese');

  // wrong domain is refused
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(BASE);
  await p2.getByText('Đăng ký', { exact: true }).click();
  await p2.locator('label.field', { hasText: 'Họ tên' }).locator('input').fill('Outsider');
  await p2.locator('input[type=email]').fill('someone@gmail.com');
  await p2.locator('input[type=password]').fill('Password#1');
  await p2.locator('form button.primary').click();
  await p2.getByText('không được phép đăng ký').waitFor({ timeout: 10000 });
  await ctx2.close();
  log('non-company e-mail refused');

  // ------------------------------------------------------------ language switch
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.getByText('Hello Trương Admin').waitFor();
  await page.getByRole('button', { name: 'VI', exact: true }).click();
  log('VI/EN switch');

  // ------------------------------------------------------------ project + IDEF0
  await page.getByRole('link', { name: /Dự án/ }).first().click();
  await page.getByText('DEMO-001').first().click();
  await page.getByText('Tạo từ mẫu vòng đời dự án').click();
  await page.locator('.tree .node', { hasText: 'Bảo hành & đóng dự án' }).first().waitFor({ timeout: 15000 });
  await page.locator('.diagram svg rect.box').nth(7).waitFor({ timeout: 10000 });
  const boxes = await page.locator('.diagram svg rect.box').count();
  assert.ok(boxes >= 8, `diagram boxes: ${boxes}`);
  await shot('idef0-a0');
  await page.locator('.tree .node', { hasText: 'Thiết kế máy' }).click();
  await page.getByText(/Sơ đồ phân rã của A3/).waitFor();
  await page.locator('.diagram svg text', { hasText: 'A36' }).waitFor();
  await shot('idef0-a3');
  // assign + progress on a leaf
  await page.locator('.tree .node', { hasText: 'Thiết kế cơ khí' }).click();
  const actForm = page.locator('.card', { hasText: 'Mũi tên ICOM' }).locator('..');
  await page.locator('label.field', { hasText: 'Tiến độ' }).locator('input').fill('50');
  await page.locator('.card-head', { hasText: 'A32' }).getByRole('button', { name: 'Lưu' }).click();
  await toast(/Đã lưu/);
  void actForm;
  log('IDEF0 template applied, decomposition diagram A3 shown, activity updated');

  const projectUrl = page.url().split('?')[0];
  const projectId = projectUrl.split('/').pop();

  // ------------------------------------------------------------ BOM
  await page.goto(`${BASE}/r/boms/new?project=${projectId}`);
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.waitForURL(/\/r\/boms\/[0-9a-f-]{36}$/);
  for (const [sku, qty] of [['EL1008', '4'], ['DSBC', '6']]) {
    await page.getByRole('button', { name: '+ Thêm dòng' }).click();
    const drawer = page.locator('.drawer');
    await pickRef('Vật tư', sku, sku, drawer);
    await drawer.locator('label.field', { hasText: 'SL / cụm cha' }).locator('input').fill(qty);
    await drawer.getByRole('button', { name: 'Lưu' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  await page.locator('table.data tbody tr').nth(1).waitFor();
  await page.getByRole('button', { name: 'Gửi duyệt' }).click();
  await toast(/Đã gửi duyệt/);
  await page.getByRole('button', { name: '✔ Duyệt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Duyệt' }).click();
  await page.locator('.page-head .badge', { hasText: 'Đã duyệt' }).waitFor({ timeout: 10000 });
  await shot('bom-approved');
  log('BOM created with 2 lines, submitted and approved; lines locked');

  // ------------------------------------------------------------ PR from BOM
  await page.getByRole('button', { name: /Tạo PR từ BOM/ }).click();
  await page.locator('.dialog').getByText('Trừ tồn kho hiện có').waitFor();
  await page.locator('.dialog').getByRole('button', { name: 'Tạo' }).click();
  await page.waitForURL(/\/r\/purchase_requests\/[0-9a-f-]{36}$/);
  await page.locator('table.data tbody tr').nth(1).waitFor();
  await page.getByRole('button', { name: 'Gửi duyệt' }).click();
  await toast(/Đã gửi duyệt/);
  await page.getByRole('button', { name: '✔ Duyệt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Duyệt' }).click();
  await page.locator('.page-head .badge', { hasText: 'Đã duyệt' }).waitFor({ timeout: 10000 });
  log('PR generated from the approved BOM and approved');

  // ------------------------------------------------------------ PO from PR
  await page.getByRole('button', { name: /Tạo PO từ PR/ }).click();
  await pickRef('Nhà cung cấp', 'BECK', 'Beckhoff', page.locator('.dialog'));
  await page.locator('.dialog').getByRole('button', { name: 'Tạo' }).click();
  await page.waitForURL(/\/r\/purchase_orders\/[0-9a-f-]{36}$/);
  // price the lines
  for (let i = 0; i < 2; i++) {
    await page.locator('table.data tbody tr').nth(i).click();
    const drawer = page.locator('.drawer');
    await drawer.locator('label.field', { hasText: 'Đơn giá' }).locator('input').fill(i === 0 ? '1250000' : '2100000');
    await drawer.getByRole('button', { name: 'Lưu' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  await page.getByRole('button', { name: 'Gửi duyệt' }).click();
  await toast(/Đã gửi duyệt/);
  await page.getByRole('button', { name: '✔ Duyệt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Duyệt' }).click();
  await page.locator('.page-head .badge', { hasText: 'Đã duyệt' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '→ Đã đặt hàng' }).click();
  await page.locator('.page-head .badge', { hasText: 'Đã đặt hàng' }).waitFor();
  // after approval only whitelisted fields (promised date …) stay editable
  await page.locator('label.field', { hasText: 'Ngày hẹn giao' }).first().locator('input').fill('2026-11-20');
  assert.equal(await page.locator('label.field', { hasText: 'Incoterm' }).locator('input').isDisabled(), true);
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await toast(/Đã lưu/);
  await shot('po-ordered');
  log('PO created from PR, priced, approved, ordered; promised date updated after approval');

  // ------------------------------------------------------------ receiving
  await page.getByRole('button', { name: /Nhận hàng/ }).click();
  await page.waitForURL(/warehouse\/receiving/);
  await page.locator('table.data tbody tr').first().waitFor();
  await shot('receiving');
  const rows = await page.locator('table.data tbody tr').count();
  for (let i = 0; i < rows; i++) {
    await page.locator('table.data tbody tr').first().getByRole('button', { name: /Nhận/ }).click();
    await toast(/Đã nhập kho/);
    await page.waitForTimeout(300);
  }
  await page.getByText('Không có dòng PO nào chờ nhận').waitFor();
  log(`received ${rows} PO lines (+ IQC inspections created)`);

  await page.goto(`${BASE}/warehouse/stock`);
  await page.locator('table.data tbody tr', { hasText: 'BK-EL1008' }).first().waitFor();
  await shot('stock');
  log('stock balance shows received goods in the project bucket');

  // ------------------------------------------------------------ project schedule & materials
  await page.goto(`${projectUrl}?tab=schedule`);
  await page.locator('.gantt-bar').first().waitFor();
  await shot('schedule');
  await page.goto(`${projectUrl}?tab=stock`);
  await page.locator('table.data tbody tr', { hasText: 'BK-EL1008' }).first().waitFor();
  await shot('materials');
  log('schedule (Gantt) and BOM-vs-actual tabs render');

  // ------------------------------------------------------------ v1.1 Structure BOM import (multi-level)
  const bomFile = `${OUT}AZTAKD610-structure.xlsx`;
  {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Quote').addRow(['Quotation sheet']);
    const ws = wb.addWorksheet('Structure BOM');
    ws.addRow(['AZTAKD610-REPEAT BoM']);
    ws.addRow(['Printed', '2026-10-01']);
    ws.addRow(['Level', 'Customer Part Number', 'Ecount Item Code', 'Description', 'Customer Rev', 'BOM.Qty', 'Unit', 'Part Type',
      'Procument Type', 'Manufacturer', 'Manufacturer Part Number', 'BOM.Find Num', 'Part Unit Cost', 'MOQ Qty', 'Lead Time', 'Supplier Name', 'Links']);
    ws.addRow([0, 'AZ-610', 'E2E-610', 'ASSY, CABLE, USER INTERFACE', 'B', 1, 'EA', 'Cable Assy', 'Make']);
    ws.addRow([1, 'AZ-C1', 'E2E-C1', 'CONN QC RCPT 22-18AWG', 'A', 16, 'each', 'OEM', 'Buy', 'TE', '8-60894-1', '1', 0.08, 100, '4 weeks', 'Beckhoff', { text: 'Link', hyperlink: 'https://example.com/c1.pdf' }]);
    ws.addRow([1, 'AZ-W1', 'E2E-W1', 'CABLE 2COND 20AWG', '', 28, 'meter', 'OEM', 'Buy', 'Alpha', '2422C', '3', 9.85, 0, '14', '', '']);
    ws.addRow([1, 'AZ-S1', 'E2E-S1', 'SUB ASSY BRACKET', 'A', 2, 'EA', 'Sub-Assembly', 'Make', '', '', '4']);
    ws.addRow([2, 'AZ-S1-1', 'E2E-S11', 'SCREW M3x8', '', 4, 'EA', 'OEM', 'Buy', 'Wurth', 'M3X8', '4.1', 0.02]);
    await wb.xlsx.writeFile(bomFile);
  }
  await page.goto(`${BASE}/r/boms/new?project=${projectId}`);
  await page.locator('label.field', { hasText: 'Tên' }).first().locator('input').fill('AZTAKD610 cable');
  await page.getByRole('button', { name: 'Lưu' }).click();
  await page.waitForURL(/\/r\/boms\/[0-9a-f-]{36}$/);
  const bom2Url = page.url();
  await page.getByRole('button', { name: /Nhập Structure BOM/ }).click();
  await page.waitForURL(/\/import\?key=structure_bom/);
  await page.locator('[data-testid=file-structure_bom]').setInputFiles(bomFile);
  await page.getByText('2 cấp').waitFor({ timeout: 15000 });
  await page.getByText(/Cụm tổng: AZ-610/).waitFor();
  await shot('import-structure-bom');
  await page.getByRole('button', { name: /Nhập 4 dòng/ }).click();
  await page.waitForURL(bom2Url);
  await page.locator('table.data tbody tr', { hasText: 'SCREW M3x8' }).locator('.bom-tree', { hasText: 'L2' }).waitFor({ timeout: 15000 });
  await page.locator('label.field', { hasText: 'Mã hàng của khách' }).first().locator('input').inputValue().then((v) => assert.equal(v, 'AZ-610'));
  await page.locator('label.field', { hasText: 'Số bộ sản xuất' }).locator('input').fill('10');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await toast(/Đã lưu/);
  await page.locator('table.data tbody tr', { hasText: 'CONN QC RCPT' }).filter({ hasText: '160' }).first().waitFor();
  await shot('bom-multilevel');
  log('Structure BOM imported from a customer-format Excel: sheet + header row detected, 3 levels, items/prices created, required qty × build qty');

  await page.getByRole('tab', { name: 'Nhu cầu ròng' }).click();
  await page.locator('.card', { hasText: 'Phân tích BOM' }).locator('table.data tbody tr', { hasText: 'CONN QC RCPT' }).waitFor();
  const [dlTree] = await Promise.all([page.waitForEvent('download'),
    page.locator('.card').filter({ has: page.locator('h3', { hasText: 'Chi tiết dòng' }) }).getByRole('button', { name: /Xuất Excel/ }).click()]);
  const treeFile = `${OUT}${dlTree.suggestedFilename()}`;
  await dlTree.saveAs(treeFile);
  {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(treeFile);
    const ws = wb.worksheets[0];
    const vals = [];
    ws.eachRow((r) => vals.push(r.values.slice(1).map((v) => (v && typeof v === 'object' && 'result' in v ? v.result : v))));
    const head = vals.findIndex((r) => r.includes('Cấp'));
    assert.ok(head > 0, 'header row with level');
    const lvl = vals[head].indexOf('Cấp');
    assert.deepEqual(vals.slice(head + 1).filter((r) => typeof r[lvl] === 'number').map((r) => r[lvl]), [1, 1, 1, 2]);
  }
  await shot('bom-net-requirement');
  log('net requirement tab and multi-level BOM Excel export (levels 1,1,1,2) verified');

  // ------------------------------------------------------------ v1.1 cost estimate → quotation
  await page.getByRole('button', { name: /Lập dự toán giá/ }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Tạo' }).click();
  await page.waitForURL(/\/r\/cost_estimates\/[0-9a-f-]{36}$/);
  await page.locator('table.calc tr', { hasText: 'Giá bán' }).first().waitFor({ timeout: 15000 });
  await page.locator('.card', { hasText: 'Nhân công lắp ráp' }).locator('table.data tbody tr').first().waitFor();
  await shot('cost-estimate');
  await page.getByRole('button', { name: 'Gửi duyệt' }).click();
  await toast(/Đã gửi duyệt/);
  await page.getByRole('button', { name: '✔ Duyệt' }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Duyệt' }).click();
  await page.locator('.page-head .badge', { hasText: 'Đã duyệt' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /Tạo báo giá/ }).click();
  await page.waitForURL(/\/r\/quotations\/[0-9a-f-]{36}$/);
  await page.locator('table.data tbody tr').first().waitFor();
  log('cost estimate built from the BOM (price book + labour templates + fee rules), approved and pushed to a quotation');

  // ------------------------------------------------------------ v1.1 RFQ → award → PO
  await page.goto(bom2Url);
  await page.getByRole('button', { name: /Tạo RFQ/ }).click();
  await pickRef('Nhà cung cấp được hỏi', 'BECK', 'Beckhoff', page.locator('.dialog'));
  await page.locator('.dialog .badge', { hasText: 'Beckhoff' }).waitFor();
  await page.locator('.dialog').getByRole('button', { name: 'Tạo' }).click();
  await page.waitForURL(/\/r\/rfqs\/[0-9a-f-]{36}$/);
  await page.locator('.card', { hasText: 'Nhà cung cấp được hỏi' }).locator('table.data tbody tr', { hasText: 'Beckhoff' }).waitFor();
  await page.getByRole('button', { name: /Gửi RFQ/ }).click();
  await toast(/Đã gửi RFQ/);
  await page.locator('.page-head .badge', { hasText: 'Đã gửi' }).waitFor();
  await page.getByRole('button', { name: '+ Nhập báo giá' }).click();
  {
    const drawer = page.locator('.drawer');
    await pickRef('Dòng RFQ', 'CONN', 'CONN QC', drawer);
    await pickRef('Nhà cung cấp', 'Beck', 'Beckhoff', drawer);
    await drawer.locator('label.field', { hasText: 'Đơn giá' }).locator('input').fill('0.07');
    await drawer.locator('label.field', { hasText: 'MOQ' }).locator('input').fill('200');
    await drawer.getByRole('button', { name: 'Lưu' }).click();
    await drawer.waitFor({ state: 'detached' });
  }
  await page.getByRole('button', { name: /✓ Chọn/ }).first().click();
  await toast(/Đã chọn NCC/);
  await shot('rfq-comparison');
  await page.getByRole('button', { name: /Tạo PO từ RFQ/ }).click();
  await page.waitForURL(/\/r\/purchase_orders\/[0-9a-f-]{36}$/);
  await page.locator('table.data tbody tr').first().waitFor();
  log('RFQ created from the BOM, sent, vendor quote entered and awarded (→ price book), draft PO created');

  // ------------------------------------------------------------ v1.1 Ecount item import
  const ecFile = `${OUT}ecount-items.xlsx`;
  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Item');
    ws.addRow(['Item List']);
    ws.addRow(['Item Code', 'Item Code (External)', 'Item Name', 'Spec.', 'Unit', 'Customer/Vendor Name', 'Purchase Price', 'Item Category', 'Active']);
    ws.addRow(['E2E-C1', '8-60894-1', 'CONN QC RCPT (Ecount)', '22-18AWG', 'EA', 'Beckhoff', 0.075, 'Connector', 'Yes']);
    ws.addRow(['E2E-NEW1', 'XYZ-1', 'HEAT SHRINK 6MM', '', 'DRUM', '', 12.5, 'Consumable', 'Yes']);
    await wb.xlsx.writeFile(ecFile);
  }
  await page.goto(`${BASE}/import?key=ecount_items`);
  await page.locator('[data-testid=file-ecount_items]').setInputFiles(ecFile);
  await page.getByText(/Đơn vị mới sẽ được tạo: DRUM/).waitFor({ timeout: 15000 });
  await page.getByRole('button', { name: /Nhập 2 dòng/ }).click();
  await page.getByText(/Cập nhật 1, tạo mới 1 mã hàng, 2 giá/).waitFor({ timeout: 15000 });
  await shot('import-ecount');
  await page.goto(`${BASE}/r/item_prices`);
  await page.locator('table.data tbody tr', { hasText: 'E2E-NEW1' }).first().waitFor();
  log('Ecount item list imported by item code (1 updated, 1 created, new unit DRUM), prices in the price book');

  // ------------------------------------------------------------ Excel export
  await page.goto(`${BASE}/exports`);
  await page.getByRole('tab', { name: 'Mua hàng' }).click();
  await page.getByText('Dòng đơn mua (PO)').click();
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Xuất Excel/ }).click()]);
  const file = `${OUT}${dl.suggestedFilename()}`;
  await dl.saveAs(file);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.worksheets[0];
  assert.match(String(ws.getCell('A1').value), /Apillis — Dòng đơn mua \(PO\)/);
  assert.equal(ws.getCell('A5').value, 'PO');
  assert.match(String(ws.getCell('A6').value), /^PO-\d{4}-\d{4}$/);
  await shot('export-center');
  log(`Excel export downloaded and verified (${dl.suggestedFilename()})`);

  // ------------------------------------------------------------ approvals, settings, timesheets
  await page.goto(`${BASE}/approvals`);
  await page.getByRole('tab', { name: 'Tất cả' }).click();
  await page.locator('table.data tbody tr').nth(2).waitFor();
  await page.goto(`${BASE}/settings?tab=permissions`);
  await page.locator('table.matrix').waitFor();
  await shot('permission-matrix');
  await page.goto(`${BASE}/settings?tab=approvals`);
  await page.getByText('Management (≥ 100M)').waitFor();
  await page.goto(`${BASE}/timesheets`);
  await page.getByText('Tuần của tôi').waitFor();
  await shot('timesheets');
  log('approvals history, permission matrix, approval matrix and timesheets render');

  // ------------------------------------------------------------ English UI screenshot
  await page.getByRole('button', { name: 'EN', exact: true }).click();
  await page.goto(`${projectUrl}?tab=activities`);
  await page.locator('.diagram svg').waitFor();
  await shot('idef0-en');

  assert.deepEqual(errors, [], 'browser errors');
  console.log('\nE2E smoke test passed. Screenshots in', OUT);
} catch (e) {
  await shot('failure').catch(() => {});
  console.error('E2E FAILED:', e.message);
  if (errors.length) console.error('Browser errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
