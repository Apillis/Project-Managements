// v1.2: material requests, logistics, project finance (milestones, invoices,
// payments, P&L, cash flow), project closure lock, daily digest.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, asq, as, users, rejects, uid, makeProject, makeItem, makePartner, location } from '../lib.js';

after(() => pool.end());

const num = (v) => Number(v);

async function setSetting(key, value) {
  await sql(`update app_settings set value = $2::jsonb where key = $1`, [key, JSON.stringify(value)]);
}

/** approved sales order of `amount` VND (one line, given tax code) linked to the project */
async function approvedSo(u, projectId, customerId, amount, tax = 'VAT10') {
  const [so] = await asq(u.sales, `insert into sales_orders(customer_id, project_id, currency_code) values ($1, $2, 'VND') returning *`,
    [customerId, projectId]);
  await asq(u.sales, `insert into sales_order_lines(sales_order_id, description, qty, unit_price, tax_code) values ($1, 'Machine', 1, $2, $3)`,
    [so.id, amount, tax]);
  const [{ submit_for_approval: r }] = await asq(u.sales, `select submit_for_approval('sales_order', $1)`, [so.id]);
  await asq(u.management, `select decide_approval($1, 'approve')`, [r]);
  return so;
}

async function projectWithCustomer(u) {
  const p = await makeProject(u.pmo);
  const c = await makePartner(u.sales);
  await asq(u.pmo, `update projects set customer_id = $1 where id = $2`, [c.id, p.id]);
  return { p, c };
}

/** approved PO for qty × price of a new item on a new project (BOM → PR → PO) */
async function approvedPo(u, { qty = 10, price = 100000, project } = {}) {
  const p = project ?? await makeProject(u.pmo);
  const item = await makeItem(u.engineering);
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
  [{ submit_for_approval: r }] = await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po.id]);
  await asq(u.procurement2, `select decide_approval($1, 'approve')`, [r]);
  return { p, item, vendor, po, pol };
}

async function carrier(u) {
  const code = 'T' + uid();
  const [c] = await asq(u.logistics, `insert into partners(code, name, is_carrier) values ($1, $2, true) returning *`, [code, 'Carrier ' + code]);
  return c;
}

// ------------------------------------------------------------------ material requests
test('material request: approval, issue against lines, over-issue refused, status follows', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.warehouse);
  const loc = await location('A-01');
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 10, $2, 'count')`, [item.id, loc.id]);

  const [mr] = await asq(u.engineering, `insert into material_requests(project_id, title, needed_by) values ($1, 'Wiring kit', current_date + 1) returning *`, [p.id]);
  assert.match(mr.doc_no, /^MR-/);
  const [line] = await asq(u.engineering, `insert into material_request_lines(mr_id, item_id, qty) values ($1, $2, 6) returning *`, [mr.id, item.id]);
  assert.equal(line.description, item.name, 'description comes from the item');
  assert.equal(line.uom, 'PCS');
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, mr_line_id) values ('issue', $1, 1, $2, $3)`,
    [item.id, loc.id, line.id]), /not approved/);

  const [{ submit_for_approval: r }] = await asq(u.engineering, `select submit_for_approval('material_request', $1)`, [mr.id]);
  await rejects(asq(u.engineering, `select decide_approval($1, 'approve')`, [r]), /segregation|not an approver/);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [r]);
  const notes = await sql(`select title from notifications where user_id = $1 and title = $2`, [u.warehouse, `Material request ${mr.doc_no} approved`]);
  assert.equal(notes.length, 1, 'warehouse is told the request is ready to issue');

  const [m1] = await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, mr_line_id) values ('issue', $1, 4, $2, $3) returning *`,
    [item.id, loc.id, line.id]);
  assert.equal(m1.consume_project_id, p.id, 'issued to the project of the request');
  assert.equal(m1.reference, mr.doc_no);
  let [h] = await asq(u.pmo, `select status from material_requests where id = $1`, [mr.id]);
  assert.equal(h.status, 'partially_issued');
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, mr_line_id) values ('issue', $1, 3, $2, $3)`,
    [item.id, loc.id, line.id]), /Over-issue/);
  await rejects(asq(u.engineering, `update material_request_lines set qty = 1 where id = $1`, [line.id]), /locked/);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, mr_line_id) values ('issue', $1, 2, $2, $3)`,
    [item.id, loc.id, line.id]);
  [h] = await asq(u.pmo, `select status from material_requests where id = $1`, [mr.id]);
  assert.equal(h.status, 'issued');
  const [v] = await asq(u.warehouse, `select issued_qty, open_qty, free_stock from v_material_request_lines where id = $1`, [line.id]);
  assert.deepEqual([num(v.issued_qty), num(v.open_qty), num(v.free_stock)], [6, 0, 4]);
  const [bva] = await asq(u.pmo, `select issued_qty from v_bom_vs_actual where project_id = $1 and item_id = $2`, [p.id, item.id]);
  assert.equal(num(bva.issued_qty), 6, 'issues count as project consumption');

  // the request item must match; requests are read-only for the warehouse
  const other = await makeItem(u.warehouse);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 5, $2, 'count')`, [other.id, loc.id]);
  await rejects(asq(u.warehouse, `insert into material_requests(project_id) values ($1)`, [p.id]), /row-level security/);
  const [mr2] = await asq(u.engineering, `insert into material_requests(project_id) values ($1) returning *`, [p.id]);
  const [l2] = await asq(u.engineering, `insert into material_request_lines(mr_id, item_id, qty) values ($1, $2, 1) returning *`, [mr2.id, item.id]);
  const [{ submit_for_approval: r2 }] = await asq(u.engineering, `select submit_for_approval('material_request', $1)`, [mr2.id]);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [r2]);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, mr_line_id) values ('issue', $1, 1, $2, $3)`,
    [other.id, loc.id, l2.id]), /does not match/);

  // optional rule: every issue needs a request
  await setSetting('issue_requires_request', true);
  await rejects(asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id, project_id) values ('issue', $1, 1, $2, null)`,
    [item.id, loc.id]), /approved material request/);
  await setSetting('issue_requires_request', false);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, from_location_id) values ('issue', $1, 1, $2)`, [item.id, loc.id]);
});

test('receiving page: warehouse lists PO headers without prices', async () => {
  const u = await users();
  const { po } = await approvedPo(u, { qty: 3 });
  const rows = await asq(u.warehouse, `select * from v_po_receiving_docs where po_id = $1`, [po.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].po_no, po.doc_no);
  assert.equal(num(rows[0].open_qty), 3);
  assert.ok(!('unit_price' in rows[0]) && !('net_amount' in rows[0]));
  const none = await asq(u.sales, `select * from v_po_receiving_docs where po_id = $1`, [po.id]);
  assert.equal(none.length, 0, 'roles without receiving / PO rights see nothing');
});

// ------------------------------------------------------------------ logistics
test('logistics: carrier check, status stamps, delivered notification, freight by route', async () => {
  const u = await users();
  const { p, c } = await projectWithCustomer(u);
  const car = await carrier(u);
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  await rejects(asq(u.logistics, `insert into shipments(project_id, carrier_id, origin, destination, currency_code) values ($1, $2, 'A', 'B', 'VND')`,
    [p.id, vendor.id]), /not flagged as carrier/);
  const [s] = await asq(u.logistics, `insert into shipments(direction, project_id, carrier_id, origin, destination, currency_code, freight_cost, other_cost,
      planned_ship_date, planned_delivery_date, vehicle, driver, gross_weight_kg)
    values ('outbound', $1, $2, 'Apillis Dong An', 'ACME Stuttgart', 'VND', 1000000, 200000, current_date, current_date + 30, '51C-123.45', 'Anh Tuan', 600)
    returning *`, [p.id, car.id]);
  assert.match(s.doc_no, /^SH-/);
  const item = await makeItem(u.engineering);
  const [ln] = await asq(u.logistics, `insert into shipment_lines(shipment_id, item_id, qty, package_no) values ($1, $2, 1, 'P1') returning *`, [s.id, item.id]);
  assert.equal(ln.description, item.name);
  await rejects(asq(u.sales, `update shipments set status = 'booked' where id = $1 returning id`, [s.id]).then((r) => { if (!r.length) throw new Error('row-level security'); }),
    /row-level security/);
  const [t1] = await asq(u.logistics, `update shipments set status = 'in_transit' where id = $1 returning shipped_at`, [s.id]);
  assert.ok(t1.shipped_at);
  const [t2] = await asq(u.logistics, `update shipments set status = 'delivered' where id = $1 returning delivered_at`, [s.id]);
  assert.ok(t2.delivered_at);
  await rejects(asq(u.logistics, `update shipments set status = 'in_transit' where id = $1`, [s.id]), /cannot change status/);
  await asq(u.logistics, `update shipments set freight_cost = 1100000 where id = $1`, [s.id]);   // carrier bill arrives later
  const notes = await sql(`select 1 from notifications where user_id = $1 and title = $2`, [u.pmo, `Shipment ${s.doc_no} delivered`]);
  assert.equal(notes.length, 1);
  const [v] = await asq(u.sales, `select route, total_cost_base, on_time, transit_days from v_shipments where id = $1`, [s.id]);
  assert.equal(v.route, 'Apillis Dong An → ACME Stuttgart');
  assert.equal(num(v.total_cost_base), 1300000);
  assert.equal(v.on_time, true);
  const [fr] = await asq(u.logistics, `select shipments, total_cost_base, cost_per_kg_base, on_time_pct from v_freight_by_route where project_id = $1`, [p.id]);
  assert.deepEqual([num(fr.shipments), num(fr.total_cost_base), num(fr.cost_per_kg_base), num(fr.on_time_pct)], [1, 1300000, 2166.67, 100]);
  const hidden = await asq(u.qa, `select * from shipments where id = $1`, [s.id]);
  assert.equal(hidden.length, 0, 'QA has no logistics right');
  assert.ok(c.id);
});

// ------------------------------------------------------------------ finance
test('billing milestones: % of the sales order, 100 % cap, activity done → ready + Accounting notified', async () => {
  const u = await users();
  const { p, c } = await projectWithCustomer(u);
  const so = await approvedSo(u, p.id, c.id, 1000000000);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'Machine') returning *`, [p.id]);
  const [fat] = await asq(u.pmo, `insert into activities(project_id, parent_id, title, is_milestone) values ($1, $2, 'FAT with customer', true) returning *`, [p.id, root.id]);

  const [m30] = await asq(u.accounting, `insert into billing_milestones(project_id, sales_order_id, seq, name, percent) values ($1, $2, 1, '30% advance', 30) returning *`, [p.id, so.id]);
  const [m60] = await asq(u.accounting, `insert into billing_milestones(project_id, sales_order_id, seq, name, percent, activity_id) values ($1, $2, 2, '60% after FAT', 60, $3) returning *`,
    [p.id, so.id, fat.id]);
  assert.equal(m30.currency_code, 'VND', 'currency of the sales order');
  await rejects(asq(u.accounting, `insert into billing_milestones(project_id, sales_order_id, seq, name, percent) values ($1, $2, 3, 'too much', 20)`, [p.id, so.id]),
    /exceed 100/);
  await rejects(asq(u.accounting, `insert into billing_milestones(project_id, seq, name, percent) values ($1, 4, 'no SO', 10)`, [p.id]), /needs the sales order/);
  const [v] = await asq(u.pmo, `select amount_due, amount_due_base, status from v_billing_milestones where id = $1`, [m30.id]);
  assert.deepEqual([num(v.amount_due), num(v.amount_due_base), v.status], [300000000, 300000000, 'planned']);
  await rejects(asq(u.pmo, `insert into billing_milestones(project_id, seq, name, amount) values ($1, 5, 'x', 1)`, [p.id]), /row-level security/);

  await asq(u.pmo, `update activities set status = 'done' where id = $1`, [fat.id]);
  const [m] = await asq(u.accounting, `select status from billing_milestones where id = $1`, [m60.id]);
  assert.equal(m.status, 'ready');
  const notes = await sql(`select 1 from notifications where user_id = $1 and title = 'Billing milestone ready: 60% after FAT'`, [u.accounting]);
  assert.equal(notes.length, 1);
  await rejects(asq(u.accounting, `update billing_milestones set status = 'invoiced' where id = $1`, [m60.id]), /invoice workflow/);
});

test('invoice from milestone: issue locks it, payments drive status, over-payment refused', async () => {
  const u = await users();
  const { p, c } = await projectWithCustomer(u);
  const so = await approvedSo(u, p.id, c.id, 1000000000, 'VAT10');
  const [m30] = await asq(u.accounting, `insert into billing_milestones(project_id, sales_order_id, name, percent, planned_date) values ($1, $2, '30% advance', 30, current_date) returning *`,
    [p.id, so.id]);
  const [{ create_invoice_from_milestone: invId }] = await asq(u.accounting, `select create_invoice_from_milestone($1)`, [m30.id]);
  const [inv] = await asq(u.accounting, `select * from invoices where id = $1`, [invId]);
  assert.match(inv.doc_no, /^INV-/);
  assert.equal(inv.status, 'draft');
  assert.equal(inv.customer_id, c.id);
  const [line] = await asq(u.accounting, `select qty, uom, unit_price, tax_code from invoice_lines where invoice_id = $1`, [invId]);
  assert.deepEqual([num(line.qty), line.uom, num(line.unit_price), line.tax_code], [1, 'LOT', 300000000, 'VAT10']);
  await rejects(asq(u.accounting, `select create_invoice_from_milestone($1)`, [m30.id]), /already has an invoice/);
  await rejects(asq(u.accounting, `insert into payments(direction, invoice_id, amount) values ('in', $1, 1)`, [invId]), /issued, unpaid invoice/);

  const [iss] = await asq(u.accounting, `update invoices set status = 'issued', external_ref = 'MISA-0001' where id = $1 returning issued_at, due_date, invoice_date`, [invId]);
  assert.ok(iss.issued_at);
  assert.equal(new Date(iss.due_date) - new Date(iss.invoice_date), 30 * 86400000, 'due in default_payment_days');
  let [ms] = await asq(u.accounting, `select status, invoice_id from billing_milestones where id = $1`, [m30.id]);
  assert.deepEqual([ms.status, ms.invoice_id], ['invoiced', invId]);
  await rejects(asq(u.accounting, `update invoice_lines set unit_price = 1 where invoice_id = $1`, [invId]), /locked/);
  await rejects(asq(u.accounting, `update invoices set invoice_date = invoice_date - 1 where id = $1`, [invId]), /only notes/);
  await asq(u.accounting, `update invoices set notes = 'sent by e-mail' where id = $1`, [invId]);

  const [v0] = await asq(u.sales, `select total_amount, balance, status, aging_bucket from v_invoices where id = $1`, [invId]);
  assert.deepEqual([num(v0.total_amount), num(v0.balance), v0.status, v0.aging_bucket], [330000000, 330000000, 'issued', 'current']);
  const [pay1] = await asq(u.accounting, `insert into payments(direction, invoice_id, amount, reference) values ('in', $1, 100000000, 'VCB 001') returning *`, [invId]);
  assert.match(pay1.doc_no, /^PAY-/);
  assert.equal(pay1.partner_id, c.id);
  assert.equal(pay1.project_id, p.id);
  assert.equal(pay1.currency_code, 'VND');
  let [st] = await asq(u.sales, `select status, paid_amount, balance from v_invoices where id = $1`, [invId]);
  assert.deepEqual([st.status, num(st.paid_amount), num(st.balance)], ['partially_paid', 100000000, 230000000]);
  await rejects(asq(u.accounting, `insert into payments(direction, invoice_id, amount) values ('in', $1, 300000000)`, [invId]), /Over-payment/);
  await rejects(asq(u.accounting, `update payments set amount = 1 where id = $1`, [pay1.id]), /cannot be changed/);
  const [pay2] = await asq(u.accounting, `insert into payments(direction, invoice_id, amount) values ('in', $1, 230000000) returning *`, [invId]);
  [st] = await asq(u.accounting, `select status from invoices where id = $1`, [invId]);
  assert.equal(st.status, 'paid');
  [ms] = await asq(u.accounting, `select status from billing_milestones where id = $1`, [m30.id]);
  assert.equal(ms.status, 'paid');
  await rejects(asq(u.accounting, `update invoices set status = 'cancelled', cancelled_reason = 'x' where id = $1`, [invId]), /payments/);

  // a wrong receipt is deleted → status and milestone go back
  await asq(u.accounting, `delete from payments where id = $1`, [pay2.id]);
  [st] = await asq(u.accounting, `select status, paid_amount from invoices where id = $1`, [invId]);
  assert.deepEqual([st.status, num(st.paid_amount)], ['partially_paid', 100000000]);
  await rejects(asq(u.accounting, `update invoices set status = 'paid' where id = $1`, [invId]), /set by the payments/);
  await rejects(asq(u.accounting, `update invoices set paid_amount = 330000000 where id = $1 returning paid_amount`, [invId])
    .then((r) => { if (num(r[0].paid_amount) !== 100000000) throw new Error('paid amount changed'); throw new Error('kept'); }), /kept/);
  [ms] = await asq(u.accounting, `select status from billing_milestones where id = $1`, [m30.id]);
  assert.equal(ms.status, 'invoiced');

  // rights: sales reads invoices but not cash; nobody but Accounting writes
  assert.equal((await asq(u.sales, `select * from payments where invoice_id = $1`, [invId])).length, 0);
  await rejects(asq(u.sales, `insert into invoices(customer_id, currency_code) values ($1, 'VND')`, [c.id]), /row-level security/);
  assert.equal((await asq(u.warehouse, `select * from invoices where id = $1`, [invId])).length, 0);

  // cancelling: a draft freely, an issued one with a reason (milestone billable again)
  const [m2] = await asq(u.accounting, `insert into billing_milestones(project_id, sales_order_id, name, percent) values ($1, $2, '70% after SAT', 70) returning *`, [p.id, so.id]);
  const [{ create_invoice_from_milestone: inv2 }] = await asq(u.accounting, `select create_invoice_from_milestone($1)`, [m2.id]);
  await asq(u.accounting, `update invoices set status = 'issued' where id = $1`, [inv2]);
  await rejects(asq(u.accounting, `update invoices set status = 'cancelled' where id = $1`, [inv2]), /reason is required/);
  await asq(u.accounting, `update invoices set status = 'cancelled', cancelled_reason = 'wrong amount' where id = $1`, [inv2]);
  [ms] = await asq(u.accounting, `select status, invoice_id from billing_milestones where id = $1`, [m2.id]);
  assert.deepEqual([ms.status, ms.invoice_id], ['ready', null]);
  await rejects(asq(u.accounting, `update invoices set status = 'issued' where id = $1`, [inv2]), /cancelled/);
});

test('vendor payments are capped by the PO; project P&L and cash flow', async () => {
  const u = await users();
  const { p, c } = await projectWithCustomer(u);
  const { po, vendor } = await approvedPo(u, { qty: 10, price: 100000, project: p });   // PO total 1 000 000 (no tax code)
  await approvedSo(u, p.id, c.id, 5000000, 'EXEMPT');
  const car = await carrier(u);
  await asq(u.logistics, `insert into shipments(project_id, carrier_id, origin, destination, currency_code, freight_cost) values ($1, $2, 'VN', 'DE', 'VND', 300000)`,
    [p.id, car.id]);

  const [out1] = await asq(u.accounting, `insert into payments(direction, po_id, amount) values ('out', $1, 600000) returning *`, [po.id]);
  assert.equal(out1.partner_id, vendor.id);
  assert.equal(out1.project_id, p.id);
  await rejects(asq(u.accounting, `insert into payments(direction, po_id, amount) values ('out', $1, 500000)`, [po.id]), /Over-payment/);
  await rejects(asq(u.accounting, `insert into payments(direction, partner_id, project_id, amount) values ('out', $1, $2, 1)`, [c.id, p.id]), /vendor or carrier/);
  await rejects(asq(u.accounting, `insert into payments(direction, partner_id, amount) values ('in', $1, 1)`, [vendor.id]), /from a customer/);

  const [inv] = await asq(u.accounting, `insert into invoices(customer_id, project_id, currency_code) values ($1, $2, 'VND') returning *`, [c.id, p.id]);
  await asq(u.accounting, `insert into invoice_lines(invoice_id, description, qty, unit_price, tax_code) values ($1, 'Progress billing', 1, 2000000, 'EXEMPT')`, [inv.id]);
  await asq(u.accounting, `update invoices set status = 'issued' where id = $1`, [inv.id]);
  await asq(u.accounting, `insert into payments(direction, invoice_id, amount) values ('in', $1, 2000000)`, [inv.id]);

  const [pl] = await asq(u.accounting, `select * from v_project_pnl where project_id = $1`, [p.id]);
  const pick = (k) => num(pl[k]);
  assert.deepEqual(
    ['contract_value_base', 'invoiced_base', 'unbilled_base', 'collected_base', 'receivable_base', 'po_committed_base',
     'freight_cost_base', 'total_cost_base', 'gross_margin_base', 'gross_margin_pct', 'paid_out_base', 'net_cash_base'].map(pick),
    [5000000, 2000000, 3000000, 2000000, 0, 1000000, 300000, 1300000, 3700000, 74, 600000, 1400000]);
  const [pc] = await asq(u.accounting, `select total_cost_base, freight_cost_base, invoiced_base, collected_base from v_project_cost where project_id = $1`, [p.id]);
  assert.deepEqual(Object.values(pc).map(num), [1300000, 300000, 2000000, 2000000]);

  const cf = await asq(u.accounting, `select * from v_project_cashflow where project_id = $1 order by month`, [p.id]);
  const total = (k) => cf.reduce((a, r) => a + num(r[k]), 0);
  assert.deepEqual([total('actual_in'), total('actual_out'), total('forecast_in'), total('forecast_out')], [2000000, 600000, 0, 400000]);
  assert.equal(num(cf.at(-1).cumulative_net), 1000000);
  assert.equal((await asq(u.engineering, `select * from v_project_pnl where project_id = $1`, [p.id])).length, 0, 'finance only');
  assert.ok((await asq(u.pmo, `select * from v_project_pnl where project_id = $1`, [p.id])).length === 1);
});

// ------------------------------------------------------------------ project closure
test('project closure: checklist blocks, close locks every record, Management reopens', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  const [task] = await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'task') returning *`, [p.id, root.id]);
  const [ncr] = await asq(u.qa, `insert into ncrs(project_id, title) values ($1, 'Scratch') returning *`, [p.id]);
  const [ts] = await asq(u.engineering, `insert into timesheets(project_id, hours) values ($1, 2) returning *`, [p.id]);

  const check = Object.fromEntries((await asq(u.pmo, `select * from project_close_check($1)`, [p.id])).map((r) => [r.check_code, r.open_count]));
  assert.deepEqual([check.open_activities, check.open_ncrs, check.unapproved_timesheets, check.unpaid_invoices], [1, 1, 1, 0]);
  await rejects(asq(u.pmo, `update projects set status = 'closed' where id = $1`, [p.id]), /cannot be closed yet: open_activities \(1\), open_ncrs \(1\)/);

  await asq(u.pmo, `update activities set status = 'done' where id = $1`, [task.id]);
  await asq(u.qa, `update ncrs set root_cause = 'x', corrective_action = 'y', disposition = 'scrap', status = 'closed' where id = $1`, [ncr.id]);
  await asq(u.engineering, `select submit_timesheets(current_date - 30, current_date + 1)`);
  await asq(u.pmo, `select decide_timesheets(array[$1]::uuid[], 'approved')`, [ts.id]);
  await asq(u.pmo, `update projects set status = 'closed' where id = $1`, [p.id]);
  const note = await sql(`select 1 from notifications where user_id = $1 and title = $2`, [u.management, `Project ${p.code} closed`]);
  assert.equal(note.length, 1);

  await rejects(asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'late task')`, [p.id, root.id]), /locked/);
  await rejects(asq(u.engineering, `insert into timesheets(project_id, hours) values ($1, 1)`, [p.id]), /locked/);
  await rejects(asq(u.engineering, `insert into documents(project_id, title) values ($1, 'as-built')`, [p.id]), /locked/);
  await rejects(asq(u.engineering, `insert into boms(project_id, name) values ($1, 'Spare BOM')`, [p.id]), /locked/);
  await rejects(asq(u.pmo, `update projects set name = 'renamed' where id = $1`, [p.id]), /reopen it/);
  await rejects(asq(u.pmo, `delete from projects where id = $1`, [p.id]), /cannot be deleted/);
  await rejects(asq(u.pmo, `update projects set status = 'active' where id = $1`, [p.id]), /Only Management/);
  // warranty work goes on after closure
  await asq(u.service, `insert into service_tickets(project_id, title) values ($1, 'Warranty: sensor')`, [p.id]);

  await asq(u.management, `update projects set status = 'active' where id = $1`, [p.id]);
  await asq(u.pmo, `insert into activities(project_id, parent_id, title) values ($1, $2, 'rework after reopen')`, [p.id, root.id]);
  const reopened = await sql(`select 1 from notifications where user_id = $1 and title = $2`, [u.pmo, `Project ${p.code} reopened`]);
  assert.equal(reopened.length, 1);
});

test('cancelled project: records are locked but pending approvals can still be withdrawn', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering);
  const [mr] = await asq(u.engineering, `insert into material_requests(project_id) values ($1) returning *`, [p.id]);
  await asq(u.engineering, `insert into material_request_lines(mr_id, item_id, qty) values ($1, $2, 1)`, [mr.id, item.id]);
  const [{ submit_for_approval: r }] = await asq(u.engineering, `select submit_for_approval('material_request', $1)`, [mr.id]);
  await asq(u.pmo, `update projects set status = 'cancelled' where id = $1`, [p.id]);
  await rejects(asq(u.engineering, `insert into material_requests(project_id) values ($1)`, [p.id]), /cancelled — its records are locked/);
  await asq(u.engineering, `select cancel_approval($1)`, [r]);
  const [m] = await asq(u.engineering, `select status from material_requests where id = $1`, [mr.id]);
  assert.equal(m.status, 'draft');
});

// ------------------------------------------------------------------ daily digest
test('daily digest: once a day, in the recipient language, admin can force it', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [root] = await asq(u.pmo, `insert into activities(project_id, title) values ($1, 'root') returning *`, [p.id]);
  await asq(u.pmo, `insert into activities(project_id, parent_id, title, assignee_id, planned_start, planned_end)
                    values ($1, $2, 'Wire panel', $3, current_date - 10, current_date - 3)`, [p.id, root.id, u.production]);
  await sql(`update profiles set locale = 'en' where id = $1`, [u.production]);
  await setSetting('digest_hour', 0);
  await sql(`delete from digest_runs`);

  const [{ run_daily_digest: n1 }] = await sql(`select app.run_daily_digest()`);
  assert.ok(n1 >= 1);
  const [{ run_daily_digest: n2 }] = await sql(`select app.run_daily_digest()`);
  assert.equal(n2, 0, 'runs only once a day');
  const [mine] = await sql(`select title, body, link from notifications where user_id = $1 and title like 'Overdue tasks:%' order by id desc limit 1`, [u.production]);
  assert.equal(mine.title, 'Overdue tasks: 1');
  assert.match(mine.body, new RegExp(`${p.code} A1 Wire panel \\(\\d+\\)`));   // days overdue (company time zone)
  assert.equal(mine.link, '/my-tasks');
  const [run] = await sql(`select notifications from digest_runs`);
  assert.equal(run.notifications, n1);

  await rejects(asq(u.pmo, `select run_daily_digest_now()`), /Not allowed/);
  const [{ run_daily_digest_now: n3 }] = await asq(u.admin, `select run_daily_digest_now()`);
  assert.ok(n3 >= 1, 'forced run sends again');
  await setSetting('digest_enabled', false);
  await sql(`delete from digest_runs`);
  const [{ run_daily_digest: n4 }] = await sql(`select app.run_daily_digest()`);
  assert.equal(n4, 0, 'disabled in settings');
  await setSetting('digest_enabled', true);
  await setSetting('digest_hour', 7);
  assert.equal((await asq(u.admin, `select * from digest_runs`)).length, 0, 'digest log is service-only');
});

test('v1.2 permission matrix defaults', async () => {
  const u = await users();
  const rows = await as(u.logistics, (q) => q(`select resource, can_read, can_write from my_permissions()
                                               where resource in ('logistics','invoices','payments','mr') order by resource`));
  assert.deepEqual(rows, [
    { resource: 'invoices', can_read: false, can_write: false },
    { resource: 'logistics', can_read: true, can_write: true },
    { resource: 'mr', can_read: true, can_write: false },
    { resource: 'payments', can_read: false, can_write: false },
  ]);
  const acc = await asq(u.accounting, `select resource, can_write from my_permissions() where resource in ('invoices','payments') order by resource`);
  assert.deepEqual(acc.map((r) => r.can_write), [true, true]);
});
