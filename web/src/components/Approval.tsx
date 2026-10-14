import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { fmtDateTime, fmtMoney } from '../lib/format';
import type { Row } from '../lib/types';
import { PromptDialog, StatusBadge, useAction } from './ui';

export interface ApprovalRequest extends Row {
  id: string; doc_type: string; doc_id: string; doc_no: string; status: string; current_step: number | null;
  requested_by: string; requested_at: string; amount_base: number;
}

/** Approval history + actions for one document */
export function ApprovalPanel({ docType, docId, status, resource, onChanged }: {
  docType: string; docId: string; status: string; resource: string; onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const { can, session } = useAuth();
  const { busy, run } = useAction();
  const [requests, setRequests] = useState<ApprovalRequest[]>([]);
  const [steps, setSteps] = useState<Row[]>([]);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [mine, setMine] = useState<string[]>([]);
  const [dialog, setDialog] = useState<'approve' | 'reject' | null>(null);

  const load = useCallback(async () => {
    const reqs = await must(supabase.from('approval_requests').select('*').eq('doc_type', docType).eq('doc_id', docId)
      .order('requested_at', { ascending: false }));
    const list = (reqs as ApprovalRequest[]) ?? [];
    setRequests(list);
    if (list.length) {
      const st = await must(supabase.from('approval_steps').select('*').in('request_id', list.map((r) => r.id)).order('step_no'));
      setSteps((st as Row[]) ?? []);
      const ids = Array.from(new Set([...list.map((r) => r.requested_by), ...((st as Row[]) ?? []).map((s) => s.decided_by)].filter(Boolean)));
      if (ids.length) {
        const ps = await must(supabase.from('profiles').select('id, full_name, email').in('id', ids));
        setPeople(Object.fromEntries(((ps as Row[]) ?? []).map((p) => [p.id, p.full_name || p.email])));
      }
    } else setSteps([]);
    const pend = await must(supabase.rpc('my_pending_approvals'));
    setMine(((pend as Row[]) ?? []).map((r) => r.id));
  }, [docType, docId]);

  useEffect(() => { load().catch(() => setRequests([])); }, [load, status]);

  const current = requests.find((r) => r.status === 'pending');
  const canSubmit = can(resource, 'write') && (status === 'draft' || status === 'rejected');
  const canDecide = current && mine.includes(current.id);
  const canWithdraw = current && current.requested_by === session?.user.id;

  const after = async () => { await load(); onChanged(); };

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('ap.title')}</h3><div className="spacer" />
        {canSubmit && <button className="btn primary" disabled={busy} onClick={() => run(async () => {
          await must(supabase.rpc('submit_for_approval', { p_doc_type: docType, p_doc_id: docId }));
          await after();
        }, t('ap.submitted'))}>{t('ap.submit')}</button>}
        {canDecide && <>
          <button className="btn ok" disabled={busy} onClick={() => setDialog('approve')}>✔ {t('ap.approve')}</button>
          <button className="btn danger" disabled={busy} onClick={() => setDialog('reject')}>✕ {t('ap.reject')}</button>
        </>}
        {canWithdraw && <button className="btn" disabled={busy} onClick={() => run(async () => {
          await must(supabase.rpc('cancel_approval', { p_request_id: current!.id }));
          await after();
        })}>{t('ap.withdraw')}</button>}
      </div>
      <div className="card-body">
        {requests.length === 0 && <div className="muted small">{t('ap.none')}</div>}
        {requests.map((r) => (
          <div key={r.id} style={{ marginBottom: 12 }}>
            <div className="row small">
              <StatusBadge value={r.status} />
              <span>{t('ap.requestedBy', { name: people[r.requested_by] ?? '…', at: fmtDateTime(r.requested_at, lang) })}</span>
              {Number(r.amount_base) > 0 && <span className="muted">· {fmtMoney(r.amount_base, lang)} ({t('ap.base')})</span>}
            </div>
            <table className="data" style={{ marginTop: 6 }}>
              <tbody>
                {steps.filter((s) => s.request_id === r.id).map((s) => (
                  <tr key={s.id}>
                    <td style={{ width: 40 }}>#{s.step_no}</td>
                    <td>{s.name}<div className="small muted">{s.approver_role ? t(`e.role.${s.approver_role}`) : ''}</div></td>
                    <td><StatusBadge value={s.status} /></td>
                    <td className="small">{s.decided_by ? `${people[s.decided_by] ?? ''} · ${fmtDateTime(s.decided_at, lang)}` : ''}
                      {s.comment && <div className="muted">“{s.comment}”</div>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      {dialog && current && (
        <PromptDialog
          title={dialog === 'approve' ? t('ap.approve') : t('ap.reject')}
          label={dialog === 'approve' ? t('ap.commentOptional') : t('ap.commentRequired')}
          required={dialog === 'reject'} danger={dialog === 'reject'}
          confirmLabel={dialog === 'approve' ? t('ap.approve') : t('ap.reject')}
          onClose={() => setDialog(null)}
          onConfirm={async (text) => {
            await run(async () => {
              await must(supabase.rpc('decide_approval', { p_request_id: current.id, p_decision: dialog, p_comment: text || null }));
              await after();
            }, t('ap.done'));
          }}
        />
      )}
    </div>
  );
}
