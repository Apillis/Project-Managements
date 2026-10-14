import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, asq, users, rejects, makeProject, makeItem, makePartner, uid } from '../lib.js';

after(() => pool.end());

async function approvedBom(u, project, lines) {
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [project.id]);
  for (const l of lines) {
    await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, $3, '')`, [bom.id, l.item.id, l.qty]);
  }
  const [{ submit_for_approval: req }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [req]);
  return bom;
}

async function approvePr(u, prId) {
  const [{ submit_for_approval: req }] = await asq(u.procurement, `select submit_for_approval('purchase_request', $1)`, [prId]);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [req]);
}

test('BOM workflow: draft → approval → locked; status only via engine', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering, { name: 'Cylinder DSBC-32-100' });
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [p.id]);
  assert.equal(bom.revision, 'A');
  const [line] = await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, 4, '') returning *`, [bom.id, item.id]);
  assert.equal(line.description, 'Cylinder DSBC-32-100', 'description inherited from item master');
  assert.equal(line.line_no, 10);
  await rejects(asq(u.engineering, `update boms set status = 'approved' where id = $1`, [bom.id]), /system workflow/);
  await rejects(asq(u.engineering, `insert into boms(project_id, name, status) values ($1, 'x', 'approved')`, [p.id]), /draft/);

  const [{ submit_for_approval: req }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  const [b1] = await asq(u.engineering, `select status from boms where id = $1`, [bom.id]);
  assert.equal(b1.status, 'pending_approval');
  await rejects(asq(u.engineering, `update bom_lines set qty = 5 where id = $1`, [line.id]), /locked/);
  await rejects(asq(u.engineering, `select decide_approval($1, 'approve')`, [req]), /segregation|not an approver/);
  await rejects(asq(u.procurement, `select decide_approval($1, 'approve')`, [req]), /not an approver/);
  const [{ decide_approval: res }] = await asq(u.engineering_lead, `select decide_approval($1, 'approve', 'ok')`, [req]);
  assert.equal(res, 'approved');
  const [b2] = await asq(u.engineering, `select status, approved_at from boms where id = $1`, [bom.id]);
  assert.equal(b2.status, 'approved');
  assert.ok(b2.approved_at);
  await rejects(asq(u.engineering, `delete from bom_lines where id = $1`, [line.id]), /locked/);
  await rejects(asq(u.engineering, `delete from boms where id = $1`, [bom.id]), /Only draft/);
  // notification to the requester
  const notes = await asq(u.engineering, `select title from notifications where title like 'Approved:%'`);
  assert.ok(notes.length >= 1);
});

test('rejecting needs a comment; a rejected document can be edited and resubmitted', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering);
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [p.id]);
  const [line] = await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, 1, '') returning *`, [bom.id, item.id]);
  const [{ submit_for_approval: req }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  await rejects(asq(u.engineering_lead, `select decide_approval($1, 'reject')`, [req]), /comment/);
  await asq(u.engineering_lead, `select decide_approval($1, 'reject', 'qty too low')`, [req]);
  await asq(u.engineering, `update bom_lines set qty = 2 where id = $1`, [line.id]);
  const [{ submit_for_approval: req2 }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  assert.notEqual(req2, req);
  // withdraw
  await asq(u.engineering, `select cancel_approval($1)`, [req2]);
  const [b] = await asq(u.engineering, `select status from boms where id = $1`, [bom.id]);
  assert.equal(b.status, 'draft');
  await rejects(asq(u.engineering, `select submit_for_approval('bom', $1)`, [(await asq(u.engineering, `insert into boms(project_id, name) values ($1, 'Empty') returning id`, [p.id]))[0].id]), /no lines/);
});

test('BOM revision requires an approved ECO; approving rev B supersedes rev A', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering);
  const bomA = await approvedBom(u, p, [{ item, qty: 10 }]);
  await rejects(asq(u.engineering, `select new_bom_revision($1, null)`, [bomA.id]), /ECO is required/);
  const [eco] = await asq(u.engineering, `insert into ecos(project_id, bom_id, title, reason, impact_cost) values ($1, $2, 'Add sensor', 'customer_request', 5000000) returning *`, [p.id, bomA.id]);
  assert.match(eco.doc_no, /^ECO-\d{4}-\d{4}$/);
  await rejects(asq(u.engineering, `select new_bom_revision($1, $2)`, [bomA.id, eco.id]), /must be approved/);
  const [{ submit_for_approval: req }] = await asq(u.engineering, `select submit_for_approval('eco', $1)`, [eco.id]);
  const steps = await sql(`select step_no, approver_role from approval_steps where request_id = $1 order by step_no`, [req]);
  assert.deepEqual(steps, [{ step_no: 1, approver_role: 'engineering_lead' }], '5M impact < 20M → lead only');
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [req]);
  const [{ new_bom_revision: bomBId }] = await asq(u.engineering, `select new_bom_revision($1, $2)`, [bomA.id, eco.id]);
  const [bomB] = await asq(u.engineering, `select * from boms where id = $1`, [bomBId]);
  assert.equal(bomB.revision, 'B');
  assert.equal(bomB.status, 'draft');
  const [ecoAfter] = await asq(u.engineering, `select status, implemented_bom_id from ecos where id = $1`, [eco.id]);
  assert.deepEqual(ecoAfter, { status: 'implemented', implemented_bom_id: bomBId });
  const copied = await asq(u.engineering, `select count(*)::int n from bom_lines where bom_id = $1`, [bomBId]);
  assert.equal(copied[0].n, 1);
  await asq(u.engineering, `update bom_lines set qty = 12 where bom_id = $1`, [bomBId]);
  const [{ submit_for_approval: r2 }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bomBId]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [r2]);
  const revs = await asq(u.engineering, `select revision, status from boms where project_id = $1 order by rev_no`, [p.id]);
  assert.deepEqual(revs, [{ revision: 'A', status: 'superseded' }, { revision: 'B', status: 'approved' }]);
});

test('ECO with large cost impact needs management as second step', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const [eco] = await asq(u.engineering, `insert into ecos(project_id, title, impact_cost) values ($1, 'Bigger motor', 25000000) returning *`, [p.id]);
  const [{ submit_for_approval: req }] = await asq(u.engineering, `select submit_for_approval('eco', $1)`, [eco.id]);
  const [{ decide_approval: s1 }] = await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [req]);
  assert.equal(s1, 'pending');
  await rejects(asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [req]), /not an approver/);
  const [{ decide_approval: s2 }] = await asq(u.management, `select decide_approval($1, 'approve')`, [req]);
  assert.equal(s2, 'approved');
});

test('PR inherits BOM data read-only and cannot exceed BOM qty', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering, { name: 'Sensor M12' });
  const other = await makeItem(u.engineering);
  const bom = await approvedBom(u, p, [{ item, qty: 10 }]);
  const [bl] = await asq(u.engineering, `select * from bom_lines where bom_id = $1`, [bom.id]);
  const [{ create_pr_from_bom: prId }] = await asq(u.procurement, `select create_pr_from_bom($1, '2026-12-01')`, [bom.id]);
  const [prl] = await asq(u.procurement, `select * from pr_lines where pr_id = $1`, [prId]);
  assert.equal(Number(prl.qty), 10);
  assert.equal(prl.description, 'Sensor M12');
  // try to change the item → forced back to BOM item
  await asq(u.procurement, `update pr_lines set item_id = $1, description = 'hacked', qty = 6 where id = $2`, [other.id, prl.id]);
  const [prl2] = await asq(u.procurement, `select item_id, description, qty from pr_lines where id = $1`, [prl.id]);
  assert.equal(prl2.item_id, item.id);
  assert.equal(prl2.description, 'Sensor M12');
  // second PR: only 4 left
  await rejects(asq(u.procurement, `select create_pr_from_bom($1)`, [bom.id]).then(async () => {
    const [pr2] = await asq(u.procurement, `select id from purchase_requests where bom_id = $1 order by created_at desc limit 1`, [bom.id]);
    await asq(u.procurement, `insert into pr_lines(pr_id, bom_line_id, qty) values ($1, $2, 1)`, [pr2.id, bl.id]);
  }), /exceeds BOM qty/);
  // draft BOM lines cannot be requested
  const [draft] = await asq(u.engineering, `insert into boms(project_id, name) values ($1, 'Spare') returning *`, [p.id]);
  const [dl] = await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, 1, '') returning *`, [draft.id, item.id]);
  await rejects(asq(u.procurement, `insert into pr_lines(pr_id, bom_line_id, qty) values ($1, $2, 1)`, [prId, dl.id]), /approved BOM/);
  await rejects(asq(u.procurement, `select create_pr_from_bom($1)`, [draft.id]), /must be approved/);
});

test('PO: inherit PR line, qty cap, approval matrix by amount, SoD, PR status follows', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const item = await makeItem(u.engineering);
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const customer = await makePartner(u.sales, { is_customer: true });
  const bom = await approvedBom(u, p, [{ item, qty: 10 }]);
  const [{ create_pr_from_bom: prId }] = await asq(u.procurement, `select create_pr_from_bom($1)`, [bom.id]);
  const [prl] = await asq(u.procurement, `select * from pr_lines where pr_id = $1`, [prId]);
  const [po] = await asq(u.procurement, `insert into purchase_orders(vendor_id, project_id) values ($1, $2) returning *`, [vendor.id, p.id]);
  assert.equal(po.currency_code, 'VND');
  assert.equal(Number(po.exchange_rate), 1);
  await rejects(asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, 1, 100)`, [po.id, prl.id]), /approved PR/);
  await rejects(asq(u.procurement, `insert into purchase_orders(vendor_id) values ($1)`, [customer.id]), /not flagged as vendor/);
  await approvePr(u, prId);
  await rejects(asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, 11, 100)`, [po.id, prl.id]), /exceeds requested/);
  const [pol] = await asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price, description) values ($1, $2, 6, 1500000, 'ignored') returning *`, [po.id, prl.id]);
  assert.equal(pol.item_id, item.id);
  assert.equal(pol.project_id, p.id);
  assert.notEqual(pol.description, 'ignored');
  // 9M VND < 100M → one step (procurement), buyer cannot approve himself
  const [{ submit_for_approval: req }] = await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po.id]);
  const [r] = await sql(`select amount_base from approval_requests where id = $1`, [req]);
  assert.equal(Number(r.amount_base), 9000000);
  await rejects(asq(u.procurement, `select decide_approval($1, 'approve')`, [req]), /segregation/);
  await asq(u.procurement2, `select decide_approval($1, 'approve')`, [req]);
  const [pr] = await asq(u.procurement, `select status from purchase_requests where id = $1`, [prId]);
  assert.equal(pr.status, 'partially_ordered');
  const [prlAfter] = await asq(u.procurement, `select ordered_qty from pr_lines where id = $1`, [prl.id]);
  assert.equal(Number(prlAfter.ordered_qty), 6);
  // locked PO
  await rejects(asq(u.procurement, `update po_lines set unit_price = 1 where id = $1`, [pol.id]), /locked/);
  await rejects(asq(u.procurement, `update purchase_orders set vendor_id = vendor_id, currency_code = 'USD' where id = $1`, [po.id]), /locked/);
  await asq(u.procurement, `update purchase_orders set promised_date = '2026-12-15', status = 'ordered' where id = $1`, [po.id]);
  await rejects(asq(u.procurement, `update purchase_orders set status = 'received' where id = $1`, [po.id]), /system workflow/);

  // big PO → two steps
  const [po2] = await asq(u.procurement, `insert into purchase_orders(vendor_id, project_id) values ($1, $2) returning *`, [vendor.id, p.id]);
  await asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, 4, 30000000)`, [po2.id, prl.id]);
  const [{ submit_for_approval: req2 }] = await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po2.id]);
  const steps = await sql(`select step_no, approver_role, status from approval_steps where request_id = $1 order by step_no`, [req2]);
  assert.deepEqual(steps.map((s) => [s.step_no, s.approver_role, s.status]),
    [[1, 'procurement', 'pending'], [2, 'management', 'waiting']]);
  const mine = await asq(u.management, `select doc_no from my_pending_approvals()`);
  assert.ok(!mine.some((m) => m.doc_no === po2.doc_no), 'management not yet asked');
  await asq(u.procurement2, `select decide_approval($1, 'approve')`, [req2]);
  const mine2 = await asq(u.management, `select doc_no from my_pending_approvals()`);
  assert.ok(mine2.some((m) => m.doc_no === po2.doc_no));
  await asq(u.management, `select decide_approval($1, 'approve')`, [req2]);
  const [pr2] = await asq(u.procurement, `select status from purchase_requests where id = $1`, [prId]);
  assert.equal(pr2.status, 'ordered');
});

test('foreign currency: rate needed, amount converted to base', async () => {
  const u = await users();
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [po] = await asq(u.procurement, `insert into purchase_orders(vendor_id, currency_code) values ($1, 'EUR') returning *`, [vendor.id]);
  assert.equal(po.exchange_rate, null, 'no EUR rate configured yet');
  await asq(u.procurement, `insert into po_lines(po_id, description, qty, unit_price) values ($1, 'Servo motor', 2, 1000)`, [po.id]);
  await rejects(asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po.id]), /No exchange rate/);
  await asq(u.admin, `insert into exchange_rates(currency_code, rate_date, rate_to_base) values ('EUR', '2026-10-01', 30000)`);
  const [po2] = await asq(u.procurement, `insert into purchase_orders(vendor_id, currency_code) values ($1, 'EUR') returning *`, [vendor.id]);
  assert.equal(Number(po2.exchange_rate), 30000);
  await asq(u.procurement, `insert into po_lines(po_id, description, qty, unit_price, discount_pct) values ($1, 'Servo motor', 2, 1000, 10)`, [po2.id]);
  const [{ submit_for_approval: req }] = await asq(u.procurement, `select submit_for_approval('purchase_order', $1)`, [po2.id]);
  const [r] = await sql(`select amount_base from approval_requests where id = $1`, [req]);
  assert.equal(Number(r.amount_base), 54000000);
  const [v] = await asq(u.procurement, `select net_amount, net_amount_base from v_purchase_orders where id = $1`, [po2.id]);
  assert.equal(Number(v.net_amount), 1800);
  assert.equal(Number(v.net_amount_base), 54000000);
});

test('approval matrix is configurable: no rule → auto-approved', async () => {
  const u = await users();
  const customer = await makePartner(u.sales, { is_customer: true });
  await asq(u.admin, `update approval_rules set is_active = false where doc_type = 'quotation'`);
  const [q] = await asq(u.sales, `insert into quotations(customer_id, title) values ($1, 'Screw tester') returning *`, [customer.id]);
  assert.match(q.doc_no, /^QT-/);
  await asq(u.sales, `insert into quotation_lines(quotation_id, description, qty, unit_price, tax_code) values ($1, 'Machine', 1, 500000000, 'VAT10')`, [q.id]);
  await asq(u.sales, `select submit_for_approval('quotation', $1)`, [q.id]);
  const [q2] = await asq(u.sales, `select status from quotations where id = $1`, [q.id]);
  assert.equal(q2.status, 'approved');
  await asq(u.admin, `update approval_rules set is_active = true where doc_type = 'quotation'`);
  await asq(u.sales, `update quotations set status = 'sent' where id = $1`, [q.id]);
  await asq(u.sales, `update quotations set status = 'won', probability = 100 where id = $1`, [q.id]);
  const [v] = await asq(u.sales, `select net_amount, tax_amount, total_amount from v_quotations where id = $1`, [q.id]);
  assert.deepEqual([Number(v.net_amount), Number(v.tax_amount), Number(v.total_amount)], [500000000, 50000000, 550000000]);
  const notes = await asq(u.pmo, `select title from notifications where title like 'Quotation won%'`);
  assert.ok(notes.length >= 1);
  await rejects(asq(u.sales, `update quotations set status = 'draft' where id = $1`, [q.id]), /not allowed|cannot change/);
});

test('numbering is configurable per document type', async () => {
  const u = await users();
  await asq(u.admin, `update doc_sequences set prefix = 'APO', padding = 5, include_year = false where doc_type = 'purchase_order'`);
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [po] = await asq(u.procurement, `insert into purchase_orders(vendor_id) values ($1) returning doc_no`, [vendor.id]);
  assert.match(po.doc_no, /^APO-\d{5}$/);
  await asq(u.admin, `update doc_sequences set prefix = 'PO', padding = 4, include_year = true where doc_type = 'purchase_order'`);
  const [po2] = await asq(u.procurement, `insert into purchase_orders(vendor_id) values ($1) returning doc_no`, [vendor.id]);
  assert.match(po2.doc_no, /^PO-2026-\d{4}$/);
  void uid;
});
