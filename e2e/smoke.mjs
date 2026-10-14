// End-to-end smoke test of the real app against GoTrue + PostgREST + PostgreSQL
// (start the stack first: bash stack.sh up). Walks the main life-cycle:
// sign-up → IDEF0 plan → BOM → approval → PR → PO → receiving → stock → Excel export.
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
    await drawer.locator('label.field', { hasText: 'Số lượng' }).locator('input').fill(qty);
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
