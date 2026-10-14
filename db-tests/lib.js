// Test helpers: run SQL as the superuser or impersonate a signed-in user the
// same way PostgREST does (role "authenticated" + request.jwt.claims).
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pm_test';
export const pool = new pg.Pool({ connectionString: url, max: 4 });

/** Run SQL as superuser (bypasses RLS). */
export async function sql(text, params) {
  return (await pool.query(text, params)).rows;
}

/** Run fn(q) inside one transaction as the given user, like PostgREST does. */
export async function as(userId, fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', $1, true)`,
      [JSON.stringify({ sub: userId, role: 'authenticated' })]);
    await c.query('set local role authenticated');
    const q = async (text, params) => (await c.query(text, params)).rows;
    const result = await fn(q);
    await c.query('commit');
    return result;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Shortcut: single query as user. */
export const asq = (userId, text, params) => as(userId, (q) => q(text, params));

export async function createUser(email, roles = []) {
  const [u] = await sql(
    `insert into auth.users(email, raw_user_meta_data) values ($1, $2) returning id`,
    [email, { full_name: email.split('@')[0] }]);
  for (const r of roles) {
    await sql(`insert into public.user_roles(user_id, role_code) values ($1, $2) on conflict do nothing`, [u.id, r]);
  }
  return u.id;
}

export const uid = () => randomUUID().slice(0, 8);

let cached;
/** One user per role (+ a second procurement and pmo user for segregation-of-duties tests). */
export async function users() {
  if (cached) return cached;
  const [admin] = await sql(`select user_id from public.user_roles where role_code = 'admin' limit 1`);
  const adminId = admin?.user_id ?? await createUser(`admin.${uid()}@apillis.com`);
  const roles = ['management', 'pmo', 'sales', 'engineering_lead', 'engineering', 'production', 'procurement',
                 'warehouse', 'logistics', 'qa', 'accounting', 'service'];
  const out = { admin: adminId };
  for (const r of roles) out[r] = await createUser(`${r}.${uid()}@apillis.com`, [r]);
  out.procurement2 = await createUser(`procurement2.${uid()}@apillis.com`, ['procurement']);
  out.pmo2 = await createUser(`pmo2.${uid()}@apillis.com`, ['pmo']);
  cached = out;
  return out;
}

/** Expect a promise to reject with a message matching re. */
export async function rejects(promise, re) {
  try {
    await promise;
  } catch (e) {
    if (re && !re.test(e.message)) throw new Error(`Expected error ${re}, got: ${e.message}`);
    return e;
  }
  throw new Error(`Expected rejection ${re ?? ''}, but it succeeded`);
}

/** Common fixtures */
export async function makePartner(u, flags = { is_customer: true }) {
  const code = 'P' + uid();
  const [p] = await asq(u, `insert into partners(code, name, is_customer, is_vendor) values ($1, $2, $3, $4) returning *`,
    [code, 'Partner ' + code, !!flags.is_customer, !!flags.is_vendor]);
  return p;
}

export async function makeItem(u, extra = {}) {
  const sku = 'SKU-' + uid();
  const [i] = await asq(u,
    `insert into items(sku, name, uom, track_lot, track_serial, min_stock) values ($1, $2, $3, $4, $5, $6) returning *`,
    [sku, extra.name ?? 'Item ' + sku, extra.uom ?? 'pcs', !!extra.track_lot, !!extra.track_serial, extra.min_stock ?? 0]);
  return i;
}

export async function makeProject(u, extra = {}) {
  const code = 'PRJ' + uid().toUpperCase();
  const [p] = await asq(u, `insert into projects(code, name, start_date, market) values ($1, $2, $3, $4) returning *`,
    [code, 'Project ' + code, extra.start_date ?? '2026-11-02', extra.market ?? 'EU']);
  return p;
}

export async function location(code = 'A-01') {
  const [l] = await sql(`select l.* from locations l join warehouses w on w.id = l.warehouse_id
                          where w.code = 'MAIN' and l.code = $1`, [code]);
  return l;
}
