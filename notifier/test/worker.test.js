// Runs against the test database prepared by db-tests/reset-db.sh.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { backoffMinutes, makeEmailSender, makeGchatSender, processBatch, runDigest } from '../src/worker.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/pm_test';
const pool = new pg.Pool({ connectionString: url, max: 3 });

before(async () => { await pool.query('select 1'); });
after(async () => { await pool.end(); });
beforeEach(async () => { await pool.query('delete from public.notification_outbox'); });

async function add(channel, recipient, body = 'hello', subject = 'subj') {
  const { rows } = await pool.query(
    `insert into public.notification_outbox(channel, recipient, subject, body) values ($1,$2,$3,$4) returning id`,
    [channel, recipient, subject, body]);
  return rows[0].id;
}
const get = async (id) => (await pool.query('select * from public.notification_outbox where id = $1', [id])).rows[0];

test('delivers e-mail and chat rows and marks them sent', async () => {
  const mail = [], chat = [];
  const a = await add('email', 'a@apillis.com');
  const b = await add('gchat', 'https://chat.example/hook', 'NCR opened');
  const r = await processBatch(pool, { email: async (row) => mail.push(row.recipient), gchat: async (row) => chat.push(row.body) });
  assert.deepEqual(r, { sent: 2, failed: 0, retried: 0 });
  assert.deepEqual(mail, ['a@apillis.com']);
  assert.deepEqual(chat, ['NCR opened']);
  assert.equal((await get(a)).status, 'sent');
  assert.ok((await get(b)).sent_at);
  // nothing left
  assert.deepEqual(await processBatch(pool, {}), { sent: 0, failed: 0, retried: 0 });
});

test('retries with back-off, then fails permanently', async () => {
  const id = await add('email', 'x@apillis.com');
  const boom = { email: async () => { throw new Error('SMTP down'); } };
  let r = await processBatch(pool, boom, { maxAttempts: 2 });
  assert.deepEqual(r, { sent: 0, failed: 0, retried: 1 });
  let row = await get(id);
  assert.equal(row.status, 'pending');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'SMTP down');
  assert.ok(new Date(row.next_attempt_at) > new Date());
  // not due yet → untouched
  r = await processBatch(pool, boom, { maxAttempts: 2 });
  assert.equal(r.retried, 0);
  await pool.query('update public.notification_outbox set next_attempt_at = now() - interval \'1 second\' where id = $1', [id]);
  r = await processBatch(pool, boom, { maxAttempts: 2 });
  assert.deepEqual(r, { sent: 0, failed: 1, retried: 0 });
  row = await get(id);
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 2);
});

test('unconfigured channel fails immediately', async () => {
  const id = await add('email', 'y@apillis.com');
  const r = await processBatch(pool, {});
  assert.equal(r.failed, 1);
  assert.match((await get(id)).last_error, /not configured/);
});

test('two workers never send the same row twice', async () => {
  for (let i = 0; i < 30; i++) await add('gchat', 'https://chat.example/hook', 'm' + i);
  const seen = [];
  const s = { gchat: async (row) => { seen.push(row.id); await new Promise((r) => setTimeout(r, 2)); } };
  await Promise.all([processBatch(pool, s, { batchSize: 10 }), processBatch(pool, s, { batchSize: 10 }), processBatch(pool, s, { batchSize: 10 })]);
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 30);
});

test('stuck "sending" rows are released', async () => {
  const id = await add('gchat', 'https://chat.example/hook');
  await pool.query(`update public.notification_outbox set status = 'sending', next_attempt_at = now() - interval '30 minutes' where id = $1`, [id]);
  const r = await processBatch(pool, { gchat: async () => {} });
  assert.equal(r.sent, 1);
});

test('back-off grows and is capped', () => {
  assert.deepEqual([1, 2, 3, 4, 7, 10].map(backoffMinutes), [1, 2, 4, 8, 60, 60]);
});

test('Google Chat sender posts JSON text and reports HTTP errors', async () => {
  const calls = [];
  const ok = makeGchatSender(async (u, init) => { calls.push([u, init]); return { ok: true, status: 200, text: async () => '' }; });
  await ok({ recipient: 'https://chat/x', body: 'Xin chào' });
  assert.equal(calls[0][0], 'https://chat/x');
  assert.deepEqual(JSON.parse(calls[0][1].body), { text: 'Xin chào' });
  const bad = makeGchatSender(async () => ({ ok: false, status: 403, text: async () => 'forbidden' }));
  await assert.rejects(bad({ recipient: 'u', body: 'b' }), /HTTP 403/);
});

test('e-mail sender maps outbox fields to nodemailer', async () => {
  const sent = [];
  const s = makeEmailSender({ sendMail: async (m) => sent.push(m) }, 'pm@apillis.com');
  await s({ recipient: 'a@apillis.com', subject: '[Apillis PM] Approval', body: 'Please approve' });
  assert.deepEqual(sent[0], { from: 'pm@apillis.com', to: 'a@apillis.com', subject: '[Apillis PM] Approval', text: 'Please approve' });
});

test('daily digest: queued by the database once a day, then delivered by e-mail', async () => {
  const setting = (k, v) => pool.query(`update public.app_settings set value = $2::jsonb where key = $1`, [k, JSON.stringify(v)]);
  await setting('digest_hour', 0);
  await setting('notify_email_enabled', true);
  await pool.query('delete from public.digest_runs');
  const email = `digest.${Date.now()}@apillis.com`;
  const { rows: [u] } = await pool.query(`insert into auth.users(email) values ($1) returning id`, [email]);
  const { rows: [p] } = await pool.query(`insert into public.projects(code, name) values ($1, 'Digest test') returning id`, ['DG' + Date.now()]);
  const { rows: [root] } = await pool.query(`insert into public.activities(project_id, title) values ($1, 'root') returning id`, [p.id]);
  await pool.query(`insert into public.activities(project_id, parent_id, title, assignee_id, planned_start, planned_end)
                    values ($1, $2, 'Overdue', $3, current_date - 9, current_date - 5)`, [p.id, root.id, u.id]);
  try {
    assert.ok(await runDigest(pool) >= 1);
    assert.equal(await runDigest(pool), 0, 'second run the same day does nothing');
    const mail = [];
    await processBatch(pool, { email: async (row) => mail.push(row), gchat: async () => {} });
    const mine = mail.find((m) => m.recipient === email);
    assert.equal(mine?.subject, '[Apillis PM] Việc quá hạn: 1');
  } finally {
    await setting('digest_hour', 7);
    await setting('notify_email_enabled', false);
  }
  assert.equal(await runDigest({ query: async () => ({ rows: [{ n: '3' }] }) }), 3);
});
