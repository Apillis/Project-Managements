import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, asq, users, rejects, makeProject, makeItem, makePartner, location, uid } from '../lib.js';

after(() => pool.end());

async function line(u, bomId, itemId, qty, extra = {}) {
  const [l] = await asq(u.engineering, `insert into bom_lines(bom_id, item_id, qty, parent_line_id, make_or_buy, description, find_no)
    values ($1, $2, $3, $4, coalesce($5, 'buy'), coalesce($6, ''), $7) returning *`,
    [bomId, itemId, qty, extra.parent ?? null, extra.mob ?? null, extra.description ?? null, extra.find ?? null]);
  return l;
}
async function approve(u, bomId) {
  const [{ submit_for_approval: r }] = await asq(u.engineering, `select submit_for_approval('bom', $1)`, [bomId]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [r]);
}

test('units of measure are normalised and validated', async () => {
  const u = await users();
  const [i] = await asq(u.engineering, `insert into items(sku, name, uom) values ($1, 'Cable', ' meter ') returning uom`, ['U' + uid()]);
  assert.equal(i.uom, 'M');
  const [j] = await asq(u.engineering, `insert into items(sku, name, uom) values ($1, 'Pin', 'ea') returning uom`, ['U' + uid()]);
  assert.equal(j.uom, 'EA');
  const [k] = await asq(u.engineering, `insert into items(sku, name, uom) values ($1, 'Zero unit from Ecount', '0') returning uom`, ['U' + uid()]);
  assert.equal(k.uom, 'EA');
  await rejects(asq(u.engineering, `insert into items(sku, name, uom) values ($1, 'x', 'BANANA')`, ['U' + uid()]), /Unknown unit/);
  const [c] = await sql(`select app.convert_qty(null, 2.5, 'M', 'MM') a, app.convert_qty(null, 500, 'MM', 'M') b`);
  assert.deepEqual([Number(c.a), Number(c.b)], [2500, 0.5]);
  await rejects(sql(`select app.convert_qty(null, 1, 'KG', 'M')`), /No unit conversion/);
});

test('ERP code is unique; "0" placeholders become empty', async () => {
  const u = await users();
  const erp = '10000' + uid();
  const [i] = await asq(u.engineering, `insert into items(sku, name, erp_code, mpn) values ($1, 'x', $2, '0') returning erp_code, mpn`, ['E' + uid(), erp]);
  assert.equal(i.erp_code, erp);
  assert.equal(i.mpn, null);
  await rejects(asq(u.engineering, `insert into items(sku, name, erp_code) values ($1, 'y', $2)`, ['E' + uid(), erp]), /duplicate/);
  const [z] = await asq(u.engineering, `insert into items(sku, name, erp_code) values ($1, 'z', '0') returning erp_code`, ['E' + uid()]);
  assert.equal(z.erp_code, null);
});

test('multi-level BOM: levels, required qty × build qty, tree and flat views', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const asm = await makeItem(u.engineering, { name: 'Cable harness' });
  const pin = await makeItem(u.engineering, { name: 'Crimp pin' });
  const wire = await makeItem(u.engineering, { name: 'Wire 16AWG', uom: 'M' });
  const [bom] = await asq(u.engineering, `insert into boms(project_id, build_qty) values ($1, 3) returning *`, [p.id]);
  const a = await line(u, bom.id, asm.id, 2, { mob: 'make', find: '1' });
  const pn = await line(u, bom.id, pin.id, 4, { parent: a.id, find: '1.1' });
  const w = await line(u, bom.id, wire.id, 1.5, { parent: a.id, find: '1.2' });
  await line(u, bom.id, pin.id, 1, { find: '2' });          // same item also directly at level 1
  assert.equal(pn.level, 2);
  assert.equal(w.uom, 'M', 'unit taken from the item');
  const tree = await asq(u.engineering, `select find_no, level, per_unit_qty, required_qty, is_purchasable, has_children from v_bom_tree where bom_id = $1 order by sort_path`, [bom.id]);
  assert.deepEqual(tree.map((r) => [r.find_no, r.level, Number(r.per_unit_qty), Number(r.required_qty), r.is_purchasable, r.has_children]), [
    ['1', 1, 2, 6, false, true],
    ['1.1', 2, 8, 24, true, false],
    ['1.2', 2, 3, 9, true, false],
    ['2', 1, 1, 3, true, false]]);
  const flat = await asq(u.engineering, `select sku, required_qty, find_nos from v_bom_flat where bom_id = $1 order by sku`, [bom.id]);
  const pinRow = flat.find((f) => f.sku === pin.sku);
  assert.equal(Number(pinRow.required_qty), 27, '24 inside the harness + 3 loose');
  assert.equal(flat.length, 2, 'the made assembly itself is not in the flat (purchase) list');
  // a bought assembly hides its children from purchasing
  await asq(u.engineering, `update bom_lines set make_or_buy = 'buy' where id = $1`, [a.id]);
  const bought = await asq(u.engineering, `select find_no from v_bom_tree where bom_id = $1 and is_purchasable order by sort_path`, [bom.id]);
  assert.deepEqual(bought.map((r) => r.find_no), ['1', '2']);
});

test('BOM tree integrity: same BOM, no cycles, depth recomputed when moving', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const it = await makeItem(u.engineering);
  const [b1] = await asq(u.engineering, `insert into boms(project_id, name) values ($1, 'A') returning *`, [p.id]);
  const [b2] = await asq(u.engineering, `insert into boms(project_id, name) values ($1, 'B') returning *`, [p.id]);
  const x = await line(u, b1.id, it.id, 1);
  const y = await line(u, b1.id, it.id, 1, { parent: x.id });
  const z = await line(u, b1.id, it.id, 1, { parent: y.id });
  assert.equal(z.level, 3);
  await rejects(line(u, b2.id, it.id, 1, { parent: x.id }), /another BOM/);
  await rejects(asq(u.engineering, `update bom_lines set parent_line_id = $1 where id = $2`, [z.id, x.id]), /under itself/);
  await asq(u.engineering, `update bom_lines set parent_line_id = null where id = $1`, [y.id]);
  const [zz] = await asq(u.engineering, `select level from bom_lines where id = $1`, [z.id]);
  assert.equal(zz.level, 2, 'children follow when a branch moves up');
});

test('customer part number is filled from the item customer reference', async () => {
  const u = await users();
  const cust = await makePartner(u.sales, { is_customer: true });
  const [p] = await asq(u.pmo, `insert into projects(code, name, customer_id) values ($1, 'x', $2) returning *`, ['C' + uid(), cust.id]);
  const it = await makeItem(u.engineering);
  await asq(u.engineering, `insert into item_customer_refs(item_id, customer_id, customer_part_no, customer_rev) values ($1, $2, '672294', 'B')`, [it.id, cust.id]);
  await rejects(asq(u.engineering, `insert into item_customer_refs(item_id, customer_id, customer_part_no, customer_rev) values ($1, $2, '672294', 'B')`, [it.id, cust.id]), /duplicate/);
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [p.id]);
  const l = await line(u, bom.id, it.id, 1);
  assert.deepEqual([l.customer_part_no, l.customer_rev], ['672294', 'B']);
});

test('revision copy keeps the tree and header', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const it = await makeItem(u.engineering);
  const [bom] = await asq(u.engineering, `insert into boms(project_id, build_qty, customer_part_no, customer_rev) values ($1, 5, 'CPN-1', 'C') returning *`, [p.id]);
  const a = await line(u, bom.id, it.id, 2, { mob: 'make' });
  await line(u, bom.id, it.id, 3, { parent: a.id });
  await approve(u, bom.id);
  const [eco] = await asq(u.engineering, `insert into ecos(project_id, bom_id, title) values ($1, $2, 'x') returning *`, [p.id, bom.id]);
  const [{ submit_for_approval: r }] = await asq(u.engineering, `select submit_for_approval('eco', $1)`, [eco.id]);
  await asq(u.engineering_lead, `select decide_approval($1, 'approve')`, [r]);
  const [{ new_bom_revision: nb }] = await asq(u.engineering, `select new_bom_revision($1, $2)`, [bom.id, eco.id]);
  const [h] = await asq(u.engineering, `select build_qty, customer_part_no, customer_rev from boms where id = $1`, [nb]);
  assert.deepEqual([Number(h.build_qty), h.customer_part_no, h.customer_rev], [5, 'CPN-1', 'C']);
  const t = await asq(u.engineering, `select level, required_qty from v_bom_tree where bom_id = $1 order by sort_path`, [nb]);
  assert.deepEqual(t.map((x) => [x.level, Number(x.required_qty)]), [[1, 10], [2, 30]]);
});

test('PR from BOM: build qty, free stock, reservation and MOQ rounding', async () => {
  const u = await users();
  const p = await makeProject(u.pmo);
  const loc = await location('A-01');
  const a = await makeItem(u.engineering, { name: 'Terminal' });
  const b = await makeItem(u.engineering, { name: 'Relay' });
  await asq(u.procurement, `update items set moq = 100, order_multiple = 50 where id = $1`, [a.id]);
  await asq(u.warehouse, `insert into stock_moves(move_type, item_id, qty, to_location_id, notes) values ('adjust', $1, 7, $2, 'count')`, [a.id, loc.id]);
  const [bom] = await asq(u.engineering, `insert into boms(project_id, build_qty) values ($1, 2) returning *`, [p.id]);
  const la = await line(u, bom.id, a.id, 10);     // need 20
  const lb = await line(u, bom.id, b.id, 1);      // need 2
  await approve(u, bom.id);

  const net = await asq(u.procurement, `select bom_line_id, required_qty, free_stock, net_qty, suggested_order_qty from v_bom_net_requirement where bom_id = $1`, [bom.id]);
  const na = net.find((r) => r.bom_line_id === la.id);
  assert.deepEqual([Number(na.required_qty), Number(na.free_stock), Number(na.net_qty), Number(na.suggested_order_qty)], [20, 7, 13, 100]);

  await rejects(asq(u.procurement, `select create_pr_from_bom($1, null, true, true)`, [bom.id]), /warehouse write/);
  // a PM with warehouse rights reserves the free stock
  await sql(`insert into user_roles(user_id, role_code) values ($1, 'warehouse') on conflict do nothing`, [u.pmo2]);
  await sql(`insert into user_roles(user_id, role_code) values ($1, 'procurement') on conflict do nothing`, [u.pmo2]);
  const [{ create_pr_from_bom: prId }] = await asq(u.pmo2, `select create_pr_from_bom($1, null, true, true)`, [bom.id]);
  const lines = await asq(u.procurement, `select bom_line_id, qty, moq_qty from pr_lines where pr_id = $1`, [prId]);
  const pa = lines.find((l) => l.bom_line_id === la.id);
  const pb = lines.find((l) => l.bom_line_id === lb.id);
  assert.deepEqual([Number(pa.qty), Number(pa.moq_qty)], [13, 87], 'need 13 → MOQ 100');
  assert.deepEqual([Number(pb.qty), Number(pb.moq_qty)], [2, 0]);
  const bal = await asq(u.warehouse, `select project_code, qty from v_stock_balance where item_id = $1`, [a.id]);
  assert.deepEqual(bal.map((x) => [x.project_code, Number(x.qty)]), [[p.code, 7]], 'free stock reserved for the project');
  // PR cap is the build requirement, not the per-unit qty
  await rejects(asq(u.procurement, `insert into pr_lines(pr_id, bom_line_id, qty) values ($1, $2, 8)`, [prId, la.id]), /exceeds BOM qty 20/);
  // PO may include the MOQ extra
  const [{ submit_for_approval: r }] = await asq(u.procurement, `select submit_for_approval('purchase_request', $1)`, [prId]);
  await asq(u.pmo, `select decide_approval($1, 'approve')`, [r]);
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [po] = await asq(u.procurement, `insert into purchase_orders(vendor_id, project_id) values ($1, $2) returning *`, [vendor.id, p.id]);
  const [prl] = await asq(u.procurement, `select id from pr_lines where pr_id = $1 and bom_line_id = $2`, [prId, la.id]);
  await asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, 100, 1)`, [po.id, prl.id]);
  await rejects(asq(u.procurement, `insert into po_lines(po_id, pr_line_id, qty, unit_price) values ($1, $2, 1, 1)`, [po.id, prl.id]), /MOQ/);
  const [v] = await asq(u.procurement, `select qty, moq_qty, open_qty from v_pr_lines where id = $1`, [prl.id]);
  assert.equal(Number(v.open_qty), 100);
  // nothing left afterwards
  await rejects(asq(u.procurement, `select create_pr_from_bom($1)`, [bom.id]), /Nothing left/);
});

test('import_bom_tree builds the tree, creates items, customer refs and prices', async () => {
  const u = await users();
  const cust = await makePartner(u.sales, { is_customer: true });
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  const [p] = await asq(u.pmo, `insert into projects(code, name, customer_id) values ($1, 'x', $2) returning *`, ['I' + uid(), cust.id]);
  const [bom] = await asq(u.engineering, `insert into boms(project_id) values ($1) returning *`, [p.id]);
  const erp = '9' + Date.now();
  const rows = [
    { key: 'r0', level: 0, customer_part_no: 'TOP-' + erp, erp_code: erp + '0', description: 'ASSY, CABLE, USER INTERFACE', customer_rev: 'B', uom: 'EA', part_type: 'cable_assy' },
    { key: 'r1', parent_key: '', level: 1, customer_part_no: 'C-' + erp + '1', erp_code: erp + '1', description: 'CONN QC RCPT', customer_rev: 'A', qty: 16, uom: 'ea', part_type: 'oem', manufacturer: 'TE', mpn: '8-60894-1-' + erp, find_no: '1', unit_cost: 0.08, currency: 'USD', vendor_name: vendor.name },
    { key: 'r2', parent_key: '', level: 1, erp_code: erp + '2', description: 'CABLE 2COND 20AWG', qty: 28, uom: 'METER', part_type: 'oem', find_no: '3', unit_cost: 9.85 },
    { key: 'r3', parent_key: 'r2', level: 2, erp_code: erp + '3', description: 'Sub part', qty: 2, uom: 'EA' },
  ];
  await sql(`insert into user_roles(user_id, role_code) values ($1, 'procurement') on conflict do nothing`, [u.engineering]);
  const [{ import_bom_tree: n }] = await asq(u.engineering, `select import_bom_tree($1, $2::jsonb)`, [bom.id, JSON.stringify(rows)]);
  assert.equal(n, 3);
  const [h] = await asq(u.engineering, `select customer_part_no, customer_rev, top_item_id from boms where id = $1`, [bom.id]);
  assert.equal(h.customer_part_no, 'TOP-' + erp);
  assert.ok(h.top_item_id);
  const t = await asq(u.engineering, `select level, erp_code, uom, find_no, customer_part_no from v_bom_tree where bom_id = $1 order by sort_path`, [bom.id]);
  assert.deepEqual(t.map((x) => [x.level, x.erp_code, x.uom]), [[1, erp + '1', 'EA'], [1, erp + '2', 'M'], [2, erp + '3', 'EA']]);
  const refs = await asq(u.engineering, `select count(*)::int n from item_customer_refs where customer_id = $1`, [cust.id]);
  assert.equal(refs[0].n, 2);
  const prices = await asq(u.procurement, `select unit_price, vendor_id, source from item_prices i join items it on it.id = i.item_id where it.erp_code = $1`, [erp + '1']);
  assert.deepEqual([Number(prices[0].unit_price), prices[0].vendor_id, prices[0].source], [0.08, vendor.id, 'import']);
  // second import reuses items by ERP code
  const [{ count: before }] = await sql(`select count(*) from items`);
  const [bom2] = await asq(u.engineering, `insert into boms(project_id, name) values ($1, 'Copy') returning *`, [p.id]);
  await asq(u.engineering, `select import_bom_tree($1, $2::jsonb)`, [bom2.id, JSON.stringify(rows.slice(1))]);
  const [{ count: afterCount }] = await sql(`select count(*) from items`);
  assert.equal(afterCount, before);
  await rejects(asq(u.sales, `select import_bom_tree($1, '[]'::jsonb)`, [bom.id]), /Not allowed/);
});

test('import mappings and uoms are readable by everyone, editable by admin', async () => {
  const u = await users();
  const m = await asq(u.warehouse, `select field from import_mappings where import_key = 'structure_bom'`);
  assert.ok(m.length >= 15);
  await rejects(asq(u.warehouse, `insert into uoms(code, name_en, name_vi) values ('XX', 'x', 'x')`), /row-level security/);
  await asq(u.admin, `insert into uoms(code, name_en, name_vi) values ('DRUM', 'Drum', 'Thùng')`);
});
