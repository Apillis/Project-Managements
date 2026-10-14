import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, sql, as, asq, users, createUser, rejects, uid, makePartner } from '../lib.js';

after(() => pool.end());

test('every table in public has RLS enabled', async () => {
  const rows = await sql(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
  assert.deepEqual(rows, []);
});

test('anon has no privilege on any table', async () => {
  const rows = await sql(`select table_name from information_schema.role_table_grants
                           where grantee = 'anon' and table_schema = 'public'`);
  assert.deepEqual(rows, []);
});

test('all report views except v_po_receiving run as invoker', async () => {
  const rows = await sql(`select c.relname, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace
                           where n.nspname = 'public' and c.relkind = 'v'`);
  for (const r of rows) {
    const invoker = (r.reloptions ?? []).includes('security_invoker=on') || (r.reloptions ?? []).includes('security_invoker=true');
    if (r.relname === 'v_po_receiving') assert.equal(invoker, false);
    else assert.ok(invoker, `${r.relname} must use security_invoker`);
  }
});

test('first user becomes admin, later users get no role', async () => {
  const u = await users();
  const [a] = await sql(`select count(*)::int n from user_roles where role_code = 'admin'`);
  assert.equal(a.n, 1);
  const plain = await createUser(`plain.${uid()}@apillis.com`);
  const roles = await sql(`select role_code from user_roles where user_id = $1`, [plain]);
  assert.deepEqual(roles, []);
  // no role → sees nothing
  const projects = await asq(plain, `select * from projects`);
  assert.equal(projects.length, 0);
  assert.ok(u.admin);
});

test('sign-in restricted to allowed e-mail domains', async () => {
  await rejects(createUser(`hacker.${uid()}@gmail.com`), /not allowed/);
  const ok = await createUser(`Someone.${uid()}@APILLIS.COM`);
  const [p] = await sql(`select email from profiles where id = $1`, [ok]);
  assert.match(p.email, /@apillis\.com$/);
});

test('warehouse cannot see PO prices but can receive through v_po_receiving', async () => {
  const u = await users();
  const vendor = await makePartner(u.procurement, { is_vendor: true });
  await asq(u.procurement, `insert into purchase_orders(vendor_id) values ($1)`, [vendor.id]);
  const poWh = await asq(u.warehouse, `select * from purchase_orders`);
  assert.equal(poWh.length, 0, 'warehouse must not read purchase_orders');
  const linesWh = await asq(u.warehouse, `select * from po_lines`);
  assert.equal(linesWh.length, 0);
  const cols = await sql(`select column_name from information_schema.columns where table_name = 'v_po_receiving'`);
  const names = cols.map((c) => c.column_name);
  assert.ok(!names.includes('unit_price') && !names.includes('net_amount'), 'no price columns in receiving view');
  const poProc = await asq(u.procurement, `select * from purchase_orders`);
  assert.ok(poProc.length >= 1);
});

test('permission matrix is data: admin grants a right, user gains access', async () => {
  const u = await users();
  const before = await asq(u.logistics, `select app.can('qa', 'write') ok`);
  assert.equal(before[0].ok, false);
  await asq(u.admin, `insert into permissions(role_code, resource, can_read, can_write) values ('logistics', 'qa', true, true)
                      on conflict (role_code, resource) do update set can_write = true`);
  const afterRows = await asq(u.logistics, `select app.can('qa', 'write') ok`);
  assert.equal(afterRows[0].ok, true);
  await asq(u.admin, `delete from permissions where role_code = 'logistics' and resource = 'qa'`);
  // non-admin may not edit the matrix
  await rejects(asq(u.pmo, `insert into permissions(role_code, resource, can_read, can_write) values ('pmo','settings',true,true)`),
    /row-level security/);
});

test('management reads everything, writes only what the matrix allows', async () => {
  const u = await users();
  const r = await asq(u.management, `select app.can('po','read') r, app.can('po','write') w, app.can('projects','write') pw`);
  assert.deepEqual(r[0], { r: true, w: false, pw: true });
});

test('sales cannot create a BOM', async () => {
  const u = await users();
  const [proj] = await asq(u.pmo, `insert into projects(code, name) values ($1, 'x') returning id`, ['S' + uid()]);
  await rejects(asq(u.sales, `insert into boms(project_id) values ($1)`, [proj.id]), /row-level security/);
});

test('profile: user edits own name but not active flag; admin can', async () => {
  const u = await users();
  await asq(u.sales, `update profiles set full_name = 'Sales Person' where id = auth.uid()`);
  await rejects(asq(u.sales, `update profiles set is_active = false where id = auth.uid()`), /administrator/);
  const n = await asq(u.sales, `update profiles set full_name = 'x' where id = $1 returning id`, [u.qa]);
  assert.equal(n.length, 0, 'RLS hides other profiles from update');
  await asq(u.admin, `update profiles set department = 'Sales' where id = $1`, [u.sales]);
});

test('deactivated user loses all rights', async () => {
  const id = await createUser(`leaver.${uid()}@apillis.com`, ['pmo']);
  const u = await users();
  assert.equal((await asq(id, `select app.can('projects','read') ok`))[0].ok, true);
  await asq(u.admin, `update profiles set is_active = false where id = $1`, [id]);
  assert.equal((await asq(id, `select app.can('projects','read') ok`))[0].ok, false);
});

test('secret settings are hidden from non-admins', async () => {
  const u = await users();
  const rows = await asq(u.pmo, `select key from app_settings where key = 'gchat_webhook_url'`);
  assert.equal(rows.length, 0);
  const adminRows = await asq(u.admin, `select key from app_settings where key = 'gchat_webhook_url'`);
  assert.equal(adminRows.length, 1);
  const base = await asq(u.pmo, `select value from app_settings where key = 'base_currency'`);
  assert.equal(base[0].value, 'VND');
});

test('the last administrator cannot be removed', async () => {
  const u = await users();
  await rejects(sql(`delete from user_roles where user_id = $1 and role_code = 'admin'`, [u.admin]), /administrator must remain/);
});

test('my_permissions() reflects the role', async () => {
  const u = await users();
  const rows = await asq(u.warehouse, `select * from my_permissions() where resource in ('warehouse','po','po_receiving') order by resource`);
  assert.deepEqual(rows, [
    { resource: 'po', can_read: false, can_write: false },
    { resource: 'po_receiving', can_read: true, can_write: false },
    { resource: 'warehouse', can_read: true, can_write: true },
  ]);
});

test('audit log records changes with the acting user', async () => {
  const u = await users();
  const p = await makePartner(u.sales);
  await asq(u.sales, `update partners set phone = '0900' where id = $1`, [p.id]);
  const rows = await sql(`select action, new_data, changed_by from audit_log where table_name = 'partners' and row_id = $1 order by id`, [p.id]);
  assert.equal(rows[0].action, 'INSERT');
  assert.equal(rows[1].action, 'UPDATE');
  assert.deepEqual(rows[1].new_data, { phone: '0900' });
  assert.equal(rows[1].changed_by, u.sales);
  const visible = await asq(u.sales, `select * from audit_log`);
  assert.equal(visible.length, 0, 'only audit readers see the log');
  await as(u.management, async (q) => {
    const r = await q(`select count(*)::int n from audit_log`);
    assert.ok(r[0].n > 0);
  });
});
