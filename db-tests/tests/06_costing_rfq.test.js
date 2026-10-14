import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, asq, users, rejects, makePartner, uid } from '../lib.js';

// Reproduces the "Final cost to quote" sheet of the AZTAKD610 workbook in USD.
before(async () => {
  await sql(`update app_settings set value = '"USD"' where key = 'base_currency'`);
  await sql(`update app_settings set value = '100' where key = 'default_labor_rate'`);
});
after(async () => {
  await sql(`update app_settings set value = '"VND"' where key = 'base_currency'`);
  await sql(`update app_settings set value = '0' where key = 'default_labor_rate'`);
  await pool.end();
});

const PARTS = [
  // description, qty per assembly, unit cost USD, uom
  ['CABLE 2COND 20AWG', 28, 9.85, 'M'], ['HOOK-UP STRND 16AWG', 12.2, 3.96, 'M'], ['SPIRAL WRAP', 3, 8.57, 'M'],
  ['CONN PIN 18-24AWG', 18, 0.41, 'EA'], ['CONN QC RCPT', 16, 0.08, 'EA'], ['CONN PIN 16AWG', 4, 0.46, 'EA'],
  ['CONN PLUG HSG 22POS', 1, 2.44, 'EA'], ['CONN SPADE TERM', 2, 0.47, 'EA'], ['CBL TIE', 2, 0.23, 'EA'],
  ['TUBING HEATSHRINK', 0.32, 0.87, 'M'], ['LABEL KIT', 1, 3.2396, 'EA'],
];

async function cableBom(u) {
  const cust = await makePartner(u.sales, { is_customer: true });
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [p] = await asq(u.pmo, `insert into projects(code, name, customer_id) values ($1, 'Cable assy', $2) returning *`, ['Q' + uid(), cust.id]);
  const [top] = await asq(u.engineering, `insert into items(sku, name, part_type, item_type) values ($1, 'ASSY,CABLE,USER INTERFACE', 'cable_assy', 'assembly') returning *`, ['672294-' + uid()]);
  const [bom] = await asq(u.engineering, `insert into boms(project_id, build_qty, top_item_id, customer_part_no, customer_rev, build_location)
                                         values ($1, 3, $2, '672294', 'B', 'US') returning *`, [p.id, top.id]);
  const items = [];
  for (const [name, qty, price, uom] of PARTS) {
    const [it] = await asq(u.engineering, `insert into items(sku, name, uom, part_type) values ($1, $2, $3, 'oem') returning *`, ['P' + uid(), name, uom]);
    await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, description) values ($1, $2, $3, '')`, [bom.id, it.id, qty]);
    await asq(u.procurement, `insert into item_prices(item_id, vendor_id, unit_price, currency_code, source) values ($1, $2, $3, 'USD', 'quote')`, [it.id, vendor.id, price]);
    items.push(it);
  }
  return { p, bom, items, vendor, cust };
}

test('best price: lowest valid price book entry, then last PO', async () => {
  const u = await users();
  const [it] = await asq(u.engineering, `insert into items(sku, name) values ($1, 'x') returning *`, ['BP' + uid()]);
  const [none] = await sql(`select * from app.best_price($1)`, [it.id]);
  assert.equal(none.unit_price, null);
  await asq(u.procurement, `insert into item_prices(item_id, unit_price, currency_code, valid_from, valid_to) values ($1, 1, 'USD', current_date - 30, current_date - 1)`, [it.id]);
  await asq(u.procurement, `insert into item_prices(item_id, unit_price, currency_code, moq) values ($1, 5, 'USD', 10), ($1, 4, 'USD', 50)`, [it.id]);
  const [bp] = await sql(`select * from app.best_price($1)`, [it.id]);
  assert.deepEqual([Number(bp.unit_price), Number(bp.moq)], [4, 50], 'expired price ignored, cheapest valid wins');
});

test('cost estimate reproduces the quote sheet (B, C, E, F, H, K, L)', async () => {
  const u = await users();
  const { bom, items } = await cableBom(u);
  await asq(u.procurement, `update item_prices set moq = 100 where item_id = $1`, [items[8].id]);   // cable ties: MOQ 100
  await rejects(asq(u.engineering, `select build_cost_estimate($1)`, [bom.id]), /Not allowed/);
  const [{ build_cost_estimate: id }] = await asq(u.sales, `select build_cost_estimate($1, null, 'USD', 30)`, [bom.id]);
  const lines = await asq(u.sales, `select * from v_cost_estimate_lines where estimate_id = $1 order by line_no`, [id]);
  assert.equal(lines.length, PARTS.length);
  assert.equal(Number(lines[8].purchase_qty), 100);
  const labor = await asq(u.sales, `select discipline, hours_per_unit, rate from cost_estimate_labor where estimate_id = $1`, [id]);
  assert.ok(labor.every((l) => l.discipline === 'cable'), 'cable assembly → cable labour steps');
  assert.ok(Math.abs(labor.reduce((a, l) => a + Number(l.hours_per_unit), 0) - 1.6) < 1e-9);
  const fees = await asq(u.sales, `select name, total_base from v_cost_estimate_fees where estimate_id = $1`, [id]);
  assert.deepEqual(fees.map((f) => [f.name, Number(f.total_base)]), [['Forwarder fee', 58]]);

  const [e] = await asq(u.sales, `select * from v_cost_estimates where id = $1`, [id]);
  const near = (a, b, msg) => assert.ok(Math.abs(Number(a) - b) <= 0.05, `${msg}: ${a} ≠ ${b}`);
  near(e.b_material_cost, 1103.04, 'B material for 3 units');
  near(e.labor_cost_raw, 480, 'C labour');
  near(e.e_material_with_markup, 1433.95, 'E = B × 1.3');
  near(e.f_subtotal, 1913.95, 'F = C + E');
  near(e.h_fees_logistics, 58, 'H fees');
  near(e.k_sale_price_base, 1971.95, 'K');
  near(e.moq_extra_base, 94 * 0.23, 'MOQ extra');
  near(e.l_sale_price_moq_base, 1971.95 + 21.62, 'L');
  near(e.unit_sale_price, (1971.95 + 21.62) / 3, 'price per unit');
  assert.equal(Number(e.missing_prices), 0);
});

test('estimate approval, lock and push to quotation', async () => {
  const u = await users();
  const { bom } = await cableBom(u);
  const [{ build_cost_estimate: id }] = await asq(u.sales, `select build_cost_estimate($1)`, [bom.id]);
  await asq(u.sales, `update cost_estimates set markup_material_pct = 25, packing_cost = 40 where id = $1`, [id]);
  await asq(u.sales, `update cost_estimate_labor set hours_per_unit = 0 where estimate_id = $1 and step_code = '4.1'`, [id]);
  const [{ submit_for_approval: r }] = await asq(u.sales, `select submit_for_approval('cost_estimate', $1)`, [id]);
  await rejects(asq(u.sales, `update cost_estimate_lines set unit_cost = 0 where estimate_id = $1`, [id]), /locked/);
  await rejects(asq(u.sales, `update cost_estimate_labor set rate = 1 where estimate_id = $1`, [id]), /locked/);
  await rejects(asq(u.sales, `select push_estimate_to_quotation($1)`, [id]), /approved first/);
  await asq(u.management, `select decide_approval($1, 'approve')`, [r]);
  const [e] = await asq(u.sales, `select unit_sale_price, build_qty from v_cost_estimates where id = $1`, [id]);
  const [{ push_estimate_to_quotation: q }] = await asq(u.sales, `select push_estimate_to_quotation($1)`, [id]);
  const [ql] = await asq(u.sales, `select qty, unit_price from quotation_lines where quotation_id = $1`, [q]);
  assert.deepEqual([Number(ql.qty), Number(ql.unit_price)], [3, Number(e.unit_sale_price)]);
  const [st] = await asq(u.sales, `select status, quotation_id from cost_estimates where id = $1`, [id]);
  assert.deepEqual([st.status, st.quotation_id], ['quoted', q]);
});

test('costing and RFQ data are hidden from roles without rights', async () => {
  const u = await users();
  const { bom } = await cableBom(u);
  await asq(u.sales, `select build_cost_estimate($1)`, [bom.id]);
  for (const t of ['cost_estimates', 'v_cost_estimates', 'item_prices', 'rfqs', 'rfq_quotes']) {
    const rows = await asq(u.warehouse, `select * from ${t}`);
    assert.equal(rows.length, 0, `warehouse must not read ${t}`);
  }
  const eng = await asq(u.engineering, `select * from item_prices`);
  assert.equal(eng.length, 0, 'engineering does not see prices');
  const pmo = await asq(u.pmo, `select count(*)::int n from v_cost_estimates`);
  assert.ok(pmo[0].n > 0, 'PMO reads estimates');
});

test('RFQ: create from BOM, send e-mails, compare, award, feed price book and POs', async () => {
  const u = await users();
  const { p, bom, items } = await cableBom(u);
  const v1 = await makePartner(u.procurement, { is_vendor: true });
  const v2 = await makePartner(u.procurement, { is_vendor: true });
  await asq(u.procurement, `update partners set email = 'sales@v1.example' where id = $1`, [v1.id]);
  await asq(u.procurement, `insert into partner_contacts(partner_id, name, email, is_rfq_default) values ($1, 'Ms Lan', 'lan@v2.example', true)`, [v2.id]);
  const lineIds = (await asq(u.engineering, `select id from bom_lines where bom_id = $1 and item_id in ($2, $3) order by line_no`, [bom.id, items[0].id, items[1].id])).map((x) => x.id);
  await rejects(asq(u.engineering, `select create_rfq_from_bom($1)`, [bom.id]), /Not allowed/);
  const [{ create_rfq_from_bom: rfq }] = await asq(u.procurement, `select create_rfq_from_bom($1, $2::uuid[], $3::uuid[])`, [bom.id, lineIds, [v1.id, v2.id]]);
  const rl = await asq(u.procurement, `select id, qty, uom from rfq_lines where rfq_id = $1 order by line_no`, [rfq]);
  assert.deepEqual(rl.map((x) => [Number(x.qty), x.uom]), [[84, 'M'], [36.6, 'M']], 'quantities for the whole build (×3)');
  const vend = await asq(u.procurement, `select vendor_id, contact_email from rfq_vendors where rfq_id = $1 order by contact_email`, [rfq]);
  assert.deepEqual(vend.map((x) => x.contact_email).sort(), ['lan@v2.example', 'sales@v1.example']);
  const [rv1] = await asq(u.procurement, `select id from rfq_vendors where rfq_id = $1 and vendor_id = $2`, [rfq, v1.id]);
  const [rv2] = await asq(u.procurement, `select id from rfq_vendors where rfq_id = $1 and vendor_id = $2`, [rfq, v2.id]);
  await rejects(asq(u.procurement, `insert into rfq_quotes(rfq_id, rfq_line_id, rfq_vendor_id, unit_price) values ($1, $2, $3, 1)`, [rfq, rl[0].id, rv1.id]), /after the RFQ was sent/);
  await rejects(asq(u.procurement, `update rfqs set status = 'sent' where id = $1`, [rfq]), /RFQ workflow/);

  const before = await sql(`select count(*)::int n from notification_outbox where subject like '%RFQ%'`);
  const [{ send_rfq: sent }] = await asq(u.procurement, `select send_rfq($1)`, [rfq]);
  assert.equal(sent, 2);
  const mails = await sql(`select recipient, subject, body from notification_outbox where subject like '%RFQ%' order by id desc limit 2`);
  assert.equal((await sql(`select count(*)::int n from notification_outbox where subject like '%RFQ%'`))[0].n - before[0].n, 2);
  assert.ok(mails.every((m) => /CABLE 2COND 20AWG/.test(m.body) && /Qty: 84 M/.test(m.body)));
  await rejects(asq(u.procurement, `insert into rfq_lines(rfq_id, description, qty) values ($1, 'late', 1)`, [rfq]), /locked/);

  await asq(u.procurement, `insert into rfq_quotes(rfq_id, rfq_line_id, rfq_vendor_id, unit_price, currency_code, moq, lead_time_days) values
      ($1, $2, $3, 9.10, 'USD', 100, 21), ($1, $4, $3, 4.20, 'USD', 0, 21)`, [rfq, rl[0].id, rv1.id, rl[1].id]);
  await asq(u.procurement, `insert into rfq_quotes(rfq_id, rfq_line_id, rfq_vendor_id, unit_price, currency_code, lead_time_days) values
      ($1, $2, $3, 9.60, 'USD', 7), ($1, $4, $3, 3.80, 'USD', 7)`, [rfq, rl[0].id, rv2.id, rl[1].id]);
  const [st] = await asq(u.procurement, `select status from rfqs where id = $1`, [rfq]);
  assert.equal(st.status, 'quoted');
  const cmp = await asq(u.procurement, `select rfq_line_id, vendor_id, price_rank, lead_time_rank from v_rfq_comparison where rfq_id = $1`, [rfq]);
  const best0 = cmp.find((c) => c.rfq_line_id === rl[0].id && Number(c.price_rank) === 1);
  assert.equal(best0.vendor_id, v1.id);

  const q = await asq(u.procurement, `select q.id, l.line_no, rv.vendor_id from rfq_quotes q join rfq_lines l on l.id = q.rfq_line_id
                                       join rfq_vendors rv on rv.id = q.rfq_vendor_id where q.rfq_id = $1`, [rfq]);
  const pick = (lineId, vendorId) => q.find((x) => x.vendor_id === vendorId && rl.find((r) => r.id === lineId))?.id;
  await asq(u.procurement, `select award_rfq_quote($1)`, [q.find((x) => x.vendor_id === v2.id && x.line_no === Math.min(...q.map((y) => y.line_no)))?.id]);
  await asq(u.procurement, `select award_rfq_quote($1)`, [q.find((x) => x.vendor_id === v1.id && x.line_no === Math.min(...q.map((y) => y.line_no)))?.id]);
  const aw = await asq(u.procurement, `select count(*)::int n from rfq_quotes where rfq_line_id = $1 and is_awarded`, [rl[0].id]);
  assert.equal(aw[0].n, 1, 're-awarding keeps one winner per line');
  void pick;
  // award line 2 to vendor 2 (cheaper)
  const q2 = q.find((x) => x.vendor_id === v2.id && x.line_no === Math.max(...q.map((y) => y.line_no)));
  await asq(u.procurement, `select award_rfq_quote($1)`, [q2.id]);
  const [st2] = await asq(u.procurement, `select status from rfqs where id = $1`, [rfq]);
  assert.equal(st2.status, 'awarded');
  const [bp] = await sql(`select * from app.best_price($1)`, [items[1].id]);
  assert.equal(Number(bp.unit_price), 3.8, 'awarded quote is the best price in the price book now');

  // approved BOM + PR → POs are linked to PR lines
  const [{ submit_for_approval: r1 }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bom.id]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [r1]);
  const [{ create_pr_from_bom: pr }] = await asq(u.procurement, `select create_pr_from_bom($1)`, [bom.id]);
  const [{ submit_for_approval: r2 }] = await asq(u.procurement, `select submit_for_approval('purchase_request', $1)`, [pr]);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [r2]);
  const [{ create_pos_from_rfq: pos }] = await asq(u.procurement, `select create_pos_from_rfq($1)`, [rfq]);
  assert.equal(pos.length, 2);
  const pol = await asq(u.procurement, `select o.vendor_id, l.qty, l.unit_price, l.pr_line_id, l.project_id from po_lines l join purchase_orders o on o.id = l.po_id where o.id = any($1::uuid[]) order by l.unit_price desc`, [pos]);
  assert.ok(pol.every((l) => l.pr_line_id && l.project_id === p.id));
  assert.deepEqual(pol.map((l) => [Number(l.qty), Number(l.unit_price)]), [[84, 9.1], [36.6, 3.8]]);
  const [st3] = await asq(u.procurement, `select status from rfqs where id = $1`, [rfq]);
  assert.equal(st3.status, 'closed');
});

test('refresh estimate prices after an award', async () => {
  const u = await users();
  const { bom, items } = await cableBom(u);
  const [{ build_cost_estimate: id }] = await asq(u.sales, `select build_cost_estimate($1)`, [bom.id]);
  await asq(u.procurement, `insert into item_prices(item_id, unit_price, currency_code, source) values ($1, 1.00, 'USD', 'quote')`, [items[0].id]);
  const [{ refresh_cost_estimate_prices: n }] = await asq(u.sales, `select refresh_cost_estimate_prices($1)`, [id]);
  assert.equal(n, PARTS.length);
  const [l] = await asq(u.sales, `select unit_cost from cost_estimate_lines where estimate_id = $1 and item_id = $2`, [id, items[0].id]);
  assert.equal(Number(l.unit_cost), 1);
});
