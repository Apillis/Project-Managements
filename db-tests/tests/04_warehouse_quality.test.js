import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, asq, users, rejects, makeProject, makeItem, makePartner, location } from '../lib.js';

after(() => pool.end());

/** project + approved BOM + approved PR + approved PO for `qty` of a new item */
async function orderedLine(u, { qty = 10, price = 100000, itemExtra = {} } = {}) {
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering, itemExtra);
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [p.id]);
  await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, $3, '')`, [bom.id, item.id, qty]);
  let [{ submit_for_approval: r }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [r]);
  const [{ create_pr_from_bom: prId }] = await asq(u.procurement, `select create_pr_from_bom($1)`, [bom.id]);
  [{ submit_for_approval: r }] = await asq(u.procurement, `select submit_for_approval('purchase_request', $1)`, [prId]);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [r]);
  const [prl] = await asq(u.procurement, `select id from pr_lines where pr_id = $1`, [prId]);
  const [po] = await asq(u.procurement, `insert into purchase_orders(vendor_id, project_id, promised_date) values ($1, $2, current_date + 7) returning *`, [vendor.id, p.id]);
  const [pol] = await asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, $3, $4) returning *`, [po.id, prl.id, qty, price]);
  return { p, item, vendor, bom, po, pol, prId };
}

async function approvePo(u, poId) {
  const [{ submit_for_approval: r }] = await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [poId]);
  await asq(u.procurement2, `select decide_approval($1, 'approve')`, [r]);
}

test('receiving against a PO updates received qty and PO status; no over-receipt', async () => {
  const u = await users();
  const { p, item, po, pol } = await orderedLine(u, { qty: 10 });
  const loc = await location('RECV');
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 4, $2, $3)`,
    [item.id, loc.id, pol.id]), /approved\/ordered/);
  await approvePo(u, po.id);
  const recv = await asq(u.warehouse, `select * from v_po_receiving where po_line_id = $1`, [pol.id]);
  assert.equal(recv.length, 1);
  assert.equal(Number(recv[0].open_qty), 10);
  const [m] = await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 4, $2, $3) returning *`,
    [item.id, loc.id, pol.id]);
  assert.equal(m.project_id, p.id, 'received stock belongs to the project bucket');
  assert.match(m.doc_no, /^SM-/);
  const [po1] = await asq(u.procurement, `select status from purchase_orders where id = $1`, [po.id]);
  assert.equal(po1.status, 'partially_received');
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 7, $2, $3)`,
    [item.id, loc.id, pol.id]), /Over-receipt/);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 6, $2, $3)`,
    [item.id, loc.id, pol.id]);
  const [po2] = await asq(u.procurement, `select status from purchase_orders where id = $1`, [po.id]);
  assert.equal(po2.status, 'received');
  const [l] = await asq(u.procurement, `select received_qty from po_lines where id = $1`, [pol.id]);
  assert.equal(Number(l.received_qty), 10);
  // warehouse cannot post stock moves for another item on that PO line
  const other = await makeItem(u.engineering);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 1, $2, $3)`,
    [other.id, loc.id, pol.id]), /does not match|approved\/ordered/);
});

test('stock cannot go negative; issue to project; ledger is immutable', async () => {
  const u = await users();
  const { p, item, po, pol } = await orderedLine(u, { qty: 5 });
  await approvePo(u, po.id);
  const loc = await location('A-01');
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, po_line_id) values ('receipt', $1, 5, $2, $3)`, [item.id, loc.id, pol.id]);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id) values ('issue', $1, 1, $2)`, [item.id, loc.id]),
    /Insufficient stock/, );
  const [iss] = await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, project_id) values ('issue', $1, 3, $2, $3) returning *`,
    [item.id, loc.id, p.id]);
  assert.equal(iss.consume_project_id, p.id);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, project_id) values ('issue', $1, 3, $2, $3)`,
    [item.id, loc.id, p.id]), /available 2/);
  await rejects(sql(`update stock_moves set qty = 1 where id = $1`, [iss.id]), /immutable/);
  await rejects(sql(`delete from stock_moves where id = $1`, [iss.id]), /immutable/);
  await rejects(asq(u.procurement, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 1, $2, 'found')`, [item.id, loc.id]),
    /row-level security/);
  const bal = await asq(u.warehouse, `select qty, project_code from v_stock_balance where item_id = $1`, [item.id]);
  assert.deepEqual(bal.map((b) => [Number(b.qty), b.project_code]), [[2, p.code]]);
  const [bva] = await asq(u.pmo, `select bom_qty, requested_qty, ordered_qty, received_qty, issued_qty, variance_qty from v_bom_vs_actual where project_id = $1`, [p.id]);
  assert.deepEqual(Object.values(bva).map(Number), [5, 5, 5, 5, 3, -2]);
  // reserve general stock to a project via transfer between buckets
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 4, $2, 'opening stock')`, [item.id, loc.id]);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, to_location_id, to_project_id) values ('transfer', $1, 1, $2, $2, $3)`,
    [item.id, loc.id, p.id]);
  const bal2 = await asq(u.warehouse, `select qty, project_code from v_stock_balance where item_id = $1 order by project_code nulls first`, [item.id]);
  assert.deepEqual(bal2.map((b) => [Number(b.qty), b.project_code]), [[3, null], [3, p.code]]);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id) values ('adjust', $1, 1, $2)`, [item.id, loc.id]), /reason/);
});

test('lot and serial tracking', async () => {
  const u = await users();
  const loc = await location('A-01');
  const lotItem = await makeItem(u.warehouse, { track_lot: true });
  const snItem = await makeItem(u.warehouse, { track_serial: true });
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 5, $2, 'init')`, [lotItem.id, loc.id]), /Lot number/);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, lot_no, notes) values ('adjust', $1, 5, $2, 'L001', 'init')`, [lotItem.id, loc.id]);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, lot_no) values ('issue', $1, 1, $2, 'L002')`, [lotItem.id, loc.id]), /Insufficient/);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, serial_no, notes) values ('adjust', $1, 2, $2, 'SN1', 'init')`, [snItem.id, loc.id]), /one by one/);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, serial_no, notes) values ('adjust', $1, 1, $2, 'SN1', 'init')`, [snItem.id, loc.id]);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, serial_no, notes) values ('adjust', $1, 1, $2, 'SN1', 'dup')`, [snItem.id, loc.id]), /already in stock/);
});

test('low stock and aging views', async () => {
  const u = await users();
  const loc = await location('A-01');
  const item = await makeItem(u.warehouse, { min_stock: 10 });
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 3, $2, 'count')`, [item.id, loc.id]);
  const [low] = await asq(u.warehouse, `select free_qty, shortage_qty from v_low_stock where item_id = $1`, [item.id]);
  assert.deepEqual([Number(low.free_qty), Number(low.shortage_qty)], [3, 7]);
  const [age] = await asq(u.warehouse, `select age_bucket from v_inventory_aging where item_id = $1`, [item.id]);
  assert.equal(age.age_bucket, '0-30');
});

test('failed inspection opens an NCR linked to the vendor; NCR closing rules', async () => {
  const u = await users();
  const { p, item, vendor, po, pol } = await orderedLine(u, { qty: 2 });
  await approvePo(u, po.id);
  const [insp] = await asq(u.qa, `insert into inspections(inspection_type, project_id, po_line_id, item_id, qty_inspected, qty_rejected, result, notes)
                                  values ('incoming', $1, $2, $3, 2, 1, 'fail', 'Scratched housing') returning *`, [p.id, pol.id, item.id]);
  assert.match(insp.doc_no, /^QI-/);
  const [ncr] = await asq(u.qa, `select * from ncrs where inspection_id = $1`, [insp.id]);
  assert.equal(ncr.vendor_id, vendor.id);
  assert.equal(Number(ncr.qty), 1);
  await rejects(asq(u.qa, `update ncrs set status = 'closed' where id = $1`, [ncr.id]), /root cause/);
  await asq(u.qa, `update ncrs set root_cause = 'Packaging', corrective_action = 'Vendor to use foam', disposition = 'return_to_vendor', status = 'closed' where id = $1`, [ncr.id]);
  const [c] = await asq(u.qa, `select closed_at, closed_by from ncrs where id = $1`, [ncr.id]);
  assert.ok(c.closed_at);
  assert.equal(c.closed_by, u.qa);
  const [byVendor] = await asq(u.qa, `select ncr_count from v_ncr_by_vendor where vendor_name = $1`, [vendor.name]);
  assert.equal(Number(byVendor.ncr_count), 1);
  const [perf] = await asq(u.procurement, `select ncr_count from v_vendor_performance where vendor_id = $1`, [vendor.id]);
  assert.equal(Number(perf.ncr_count), 1);
  const notes = await asq(u.engineering_lead, `select title from notifications where title = $1`, ['NCR ' + ncr.doc_no]);
  assert.equal(notes.length, 1);
  await rejects(asq(u.warehouse, `insert into inspections(inspection_type, result) values ('incoming', 'pass')`), /row-level security/);
});

test('compliance dossier from EU templates; done needs evidence', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [{ apply_compliance_templates: n }] = await asq(u.qa, `select apply_compliance_templates($1, array['EU'], 'en')`, [p.id]);
  const [cnt] = await sql(`select count(*)::int n from compliance_templates where market in ('EU','GLOBAL')`);
  assert.equal(n, cnt.n);
  const [again] = await asq(u.qa, `select apply_compliance_templates($1, array['EU','US'], 'en') n`, [p.id]);
  const [us] = await sql(`select count(*)::int n from compliance_templates where market = 'US'`);
  assert.equal(again.n, us.n, 'only the new US items are added');
  const [item] = await asq(u.qa, `select * from project_compliance where project_id = $1 and code = 'EU-DOC'`, [p.id]);
  await rejects(asq(u.qa, `update project_compliance set status = 'done' where id = $1`, [item.id]), /evidence/);
  await rejects(asq(u.qa, `update project_compliance set status = 'not_applicable' where id = $1`, [item.id]), /not applicable/);
  const [d] = await asq(u.engineering, `insert into documents(project_id, category, title) values ($1, 'ce_technical_file', 'EU DoC signed') returning *`, [p.id]);
  await asq(u.qa, `update project_compliance set status = 'done', document_id = $1 where id = $2`, [d.id, item.id]);
  const [v] = await asq(u.pmo, `select status, document_title, verified_by_name from v_compliance where id = $1`, [item.id]);
  assert.equal(v.status, 'done');
  assert.equal(v.document_title, 'EU DoC signed');
  assert.ok(v.verified_by_name);
  const [vp] = await asq(u.pmo, `select open_compliance_items from v_projects where id = $1`, [p.id]);
  assert.equal(Number(vp.open_compliance_items), n + again.n - 1);
});

test('service ticket needs a resolution to close', async () => {
  const u = await users();
  const [t] = await asq(u.service, `insert into service_tickets(title) values ('Sensor fault') returning *`);
  assert.match(t.doc_no, /^SV-/);
  await rejects(asq(u.service, `update service_tickets set status = 'closed' where id = $1`, [t.id]), /Resolution/);
  const [c] = await asq(u.service, `update service_tickets set status = 'closed', resolution = 'Replaced sensor' where id = $1 returning closed_at`, [t.id]);
  assert.ok(c.closed_at);
});

test('notifications: approvers notified in-app, e-mail + Google Chat outbox when enabled', async () => {
  const u = await users();
  await asq(u.admin, `update app_settings set value = 'true' where key in ('notify_email_enabled','notify_gchat_enabled')`);
  await asq(u.admin, `update app_settings set value = '"https://chat.googleapis.com/v1/spaces/X/messages?key=k"' where key = 'gchat_webhook_url'`);
  const before = await sql(`select count(*)::int n from notification_outbox`);
  const { po } = await orderedLine(u, { qty: 1 });
  await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po.id]);
  const out = await sql(`select channel, recipient, subject from notification_outbox order by id desc limit 20`);
  const after2 = await sql(`select count(*)::int n from notification_outbox`);
  assert.ok(after2[0].n > before[0].n);
  assert.ok(out.some((o) => o.channel === 'gchat' && o.recipient.startsWith('https://chat.googleapis.com')));
  assert.ok(out.some((o) => o.channel === 'email' && o.subject.includes(po.doc_no)));
  const visible = await asq(u.admin, `select * from notification_outbox`);
  assert.equal(visible.length, 0, 'outbox is service-role only');
  const mine = await asq(u.procurement2, `select id, is_read from notifications where title like $1`, ['%' + po.doc_no]);
  assert.ok(mine.length >= 1);
  const [{ mark_notifications_read: n }] = await asq(u.procurement2, `select mark_notifications_read(null)`);
  assert.ok(n >= 1);
  await asq(u.admin, `update app_settings set value = 'false' where key in ('notify_email_enabled','notify_gchat_enabled')`);
});

test('project cost view only for finance readers', async () => {
  const u = await users();
  const { p, po } = await orderedLine(u, { qty: 2, price: 1000000 });
  await approvePo(u, po.id);
  await asq(u.admin, `insert into labor_rates(role_code, hourly_rate, currency_code) values ('engineering', 200000, 'VND')
                      on conflict (role_code) do update set hourly_rate = 200000`);
  const [ts] = await asq(u.engineering, `insert into timesheets(work_date, project_id, hours) values (current_date, $1, 5) returning id`, [p.id]);
  await asq(u.engineering, `select submit_timesheets(current_date, current_date)`);
  await asq(u.pmo, `select decide_timesheets(array[$1]::uuid[], 'approved')`, [ts.id]);
  const [c] = await asq(u.accounting, `select labor_cost_base, po_committed_base, total_cost_base from v_project_cost where project_id = $1`, [p.id]);
  assert.deepEqual(Object.values(c).map(Number), [1000000, 2000000, 3000000]);
  const hidden = await asq(u.engineering, `select * from v_project_cost where project_id = $1`, [p.id]);
  assert.equal(hidden.length, 0);
});
