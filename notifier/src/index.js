// Entry point: polls the outbox every NOTIFIER_INTERVAL_SECONDS.
//   DATABASE_URL   postgresql://postgres:<password>@db:5432/postgres
//   SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM  (optional — e-mail disabled if missing)
import pg from 'pg';
import nodemailer from 'nodemailer';
import { makeEmailSender, makeGchatSender, processBatch, runDigest } from './worker.js';

const interval = Number(process.env.NOTIFIER_INTERVAL_SECONDS ?? 15) * 1000;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });

const senders = { gchat: makeGchatSender() };
if (process.env.SMTP_HOST) {
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  senders.email = makeEmailSender(transport, process.env.SMTP_FROM ?? process.env.SMTP_USER);
} else {
  console.warn('[notifier] SMTP_HOST not set — e-mail notifications will be marked failed');
}

let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      const d = await runDigest(pool);
      if (d) console.log(`[notifier] daily digest queued ${d} reminders`);
    } catch (e) {
      console.error('[notifier] digest error:', e.message);
    }
    try {
      const r = await processBatch(pool, senders);
      if (r.sent || r.failed || r.retried) console.log(`[notifier] sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
    } catch (e) {
      console.error('[notifier] batch error:', e.message);
    }
    await new Promise((res) => setTimeout(res, interval));
  }
  await pool.end();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; });
console.log(`[notifier] started, polling every ${interval / 1000}s`);
void loop();
