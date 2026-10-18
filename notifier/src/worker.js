// Outbox worker: claims pending rows with FOR UPDATE SKIP LOCKED (safe with
// several instances), delivers them and records the result with retry/back-off.

export const DEFAULTS = {
  batchSize: 20,
  maxAttempts: 5,
  stuckMinutes: 10,
};

/** Back-off in minutes after the n-th failed attempt: 1, 2, 4, 8 … capped at 60. */
export function backoffMinutes(attempts) {
  return Math.min(60, 2 ** Math.max(0, attempts - 1));
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }} db  a pg Pool/Client
 * @param {{ email?: (row: any) => Promise<void>, gchat?: (row: any) => Promise<void> }} senders
 * @returns {Promise<{ sent: number, failed: number, retried: number }>}
 */
export async function processBatch(db, senders, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  // release rows stuck in "sending" (worker crashed mid-way)
  await db.query(
    `update public.notification_outbox set status = 'pending'
      where status = 'sending' and next_attempt_at < now() - make_interval(mins => $1)`, [o.stuckMinutes]);

  const { rows } = await db.query(
    `update public.notification_outbox o set status = 'sending', next_attempt_at = now()
      where o.id in (select id from public.notification_outbox
                      where status = 'pending' and next_attempt_at <= now()
                      order by id limit $1 for update skip locked)
      returning o.*`, [o.batchSize]);

  const result = { sent: 0, failed: 0, retried: 0 };
  for (const row of rows) {
    const send = senders[row.channel];
    try {
      if (!send) throw new Error(`Channel "${row.channel}" is not configured`);
      await send(row);
      await db.query(`update public.notification_outbox set status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = null where id = $1`, [row.id]);
      result.sent++;
    } catch (err) {
      const attempts = row.attempts + 1;
      const permanent = !send || attempts >= o.maxAttempts;
      await db.query(
        `update public.notification_outbox
            set status = $2, attempts = $3, last_error = $4,
                next_attempt_at = now() + make_interval(mins => $5)
          where id = $1`,
        [row.id, permanent ? 'failed' : 'pending', attempts, String(err?.message ?? err).slice(0, 1000), backoffMinutes(attempts)]);
      if (permanent) result.failed++; else result.retried++;
    }
  }
  return result;
}

/**
 * Daily reminder digest. The database decides whether it is time (once a day,
 * after the configured hour, company time zone) and queues the notifications
 * in the outbox, which processBatch then delivers.
 * @returns {Promise<number>} notifications created (0 when not due / already sent today)
 */
export async function runDigest(db) {
  const { rows } = await db.query('select app.run_daily_digest() as n');
  return Number(rows[0]?.n ?? 0);
}

/** Google Chat incoming webhook */
export function makeGchatSender(fetchImpl = globalThis.fetch) {
  return async (row) => {
    const res = await fetchImpl(row.recipient, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ text: row.body }),
    });
    if (!res.ok) throw new Error(`Google Chat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}

/** SMTP e-mail via nodemailer transport */
export function makeEmailSender(transport, from) {
  return async (row) => {
    await transport.sendMail({ from, to: row.recipient, subject: row.subject ?? 'Apillis PM', text: row.body });
  };
}
