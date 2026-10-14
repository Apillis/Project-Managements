import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { REF } from '../lib/resources';
import { addDays, fmtDate, fmtNumber, isoDate, weekStart } from '../lib/format';
import type { Row } from '../lib/types';
import { RefSelect } from '../components/Form';
import { ExportButton } from '../components/ExportButton';
import { Empty, PageHead, PromptDialog, Spinner, StatusBadge, Tabs, useAction } from '../components/ui';

interface Line { key: string; project_id: string; activity_id: string | null; project_code?: string; activity?: string }

export function rowKey(projectId: string, activityId: string | null) { return `${projectId}|${activityId ?? ''}`; }

export function TimesheetPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [tab, setTab] = useState<'mine' | 'approve'>('mine');
  return (
    <>
      <PageHead title={t('nav.timesheets')} sub={t('ts.sub')} />
      <Tabs tabs={[{ key: 'mine', label: t('ts.myWeek') }, { key: 'approve', label: t('ts.approve'), hidden: !can('timesheet_approve', 'write') }]}
        value={tab} onChange={setTab} />
      {tab === 'mine' ? <WeekGrid /> : <ApproveList />}
    </>
  );
}

function WeekGrid() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const { busy, run } = useAction();
  const uid = session?.user.id;
  const [monday, setMonday] = useState(() => weekStart(isoDate()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const [entries, setEntries] = useState<Row[] | null>(null);
  const [extra, setExtra] = useState<Line[]>([]);
  const [newProject, setNewProject] = useState<string | null>(null);
  const [newActivity, setNewActivity] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!uid) return;
    const data = await must(supabase.from('v_timesheets').select('*').eq('user_id', uid).gte('work_date', days[0]).lte('work_date', days[6]));
    setEntries((data as Row[]) ?? []);
  }, [uid, days]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setExtra([]); }, [monday]);

  if (!entries) return <Spinner />;

  const lines: Line[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const k = rowKey(e.project_id, e.activity_id);
    if (!seen.has(k)) { seen.add(k); lines.push({ key: k, project_id: e.project_id, activity_id: e.activity_id, project_code: e.project_code, activity: e.activity_id ? `${e.node_code} ${e.activity_title}` : '' }); }
  }
  for (const l of extra) if (!seen.has(l.key)) { seen.add(l.key); lines.push(l); }

  const cell = (l: Line, d: string) => entries.filter((e) => rowKey(e.project_id, e.activity_id) === l.key && e.work_date === d);
  const dayTotal = (d: string) => entries.filter((e) => e.work_date === d && e.status !== 'rejected').reduce((a, e) => a + Number(e.hours), 0);
  const weekTotal = days.reduce((a, d) => a + dayTotal(d), 0);

  const setHours = (l: Line, d: string, value: string) => run(async () => {
    const hrs = value === '' ? 0 : Number(value);
    if (!Number.isFinite(hrs) || hrs < 0 || hrs > 24) throw new Error(t('ts.invalidHours'));
    const existing = cell(l, d).filter((e) => e.status === 'draft' || e.status === 'rejected');
    if (existing.length) {
      const [first, ...rest] = existing;
      if (hrs === 0) await must(supabase.from('timesheets').delete().eq('id', first.id));
      else await must(supabase.from('timesheets').update({ hours: hrs, status: 'draft' }).eq('id', first.id));
      for (const r of rest) await must(supabase.from('timesheets').delete().eq('id', r.id));
    } else if (hrs > 0) {
      await must(supabase.from('timesheets').insert({ work_date: d, project_id: l.project_id, activity_id: l.activity_id, hours: hrs }));
    }
    await load();
  });

  const draftCount = entries.filter((e) => e.status === 'draft' || e.status === 'rejected').length;

  return (
    <div className="card">
      <div className="card-head">
        <button className="btn sm" onClick={() => setMonday(addDays(monday, -7))}>‹</button>
        <strong>{fmtDate(days[0], lang)} – {fmtDate(days[6], lang)}</strong>
        <button className="btn sm" onClick={() => setMonday(addDays(monday, 7))}>›</button>
        <button className="btn sm" onClick={() => setMonday(weekStart(isoDate()))}>{t('ts.thisWeek')}</button>
        <div className="spacer" />
        <ExportButton exportKey="timesheets" filters={{ dateFrom: days[0], dateTo: days[6] }} />
        <button className="btn primary" disabled={busy || draftCount === 0} onClick={() => run(async () => {
          await must(supabase.rpc('submit_timesheets', { p_from: days[0], p_to: days[6] }));
          await load();
        }, t('ts.submitted'))}>{t('ts.submitWeek')} ({draftCount})</button>
      </div>
      <div className="table-wrap">
        <table className="data ts">
          <thead><tr>
            <th>{t('f.project')}</th><th>{t('f.activity')}</th>
            {days.map((d) => <th key={d} className="num">{new Intl.DateTimeFormat(lang === 'vi' ? 'vi-VN' : 'en-GB', { weekday: 'short', day: '2-digit' }).format(new Date(d + 'T00:00:00'))}</th>)}
            <th className="num">{t('a.total')}</th>
          </tr></thead>
          <tbody>
            {lines.length === 0 && <tr><td colSpan={10}><Empty>{t('ts.empty')}</Empty></td></tr>}
            {lines.map((l) => {
              const total = days.reduce((a, d) => a + cell(l, d).filter((e) => e.status !== 'rejected').reduce((x, e) => x + Number(e.hours), 0), 0);
              return (
                <tr key={l.key}>
                  <td className="code">{l.project_code}</td>
                  <td className="small">{l.activity || <span className="muted">—</span>}</td>
                  {days.map((d) => {
                    const es = cell(l, d);
                    const locked = es.some((e) => e.status === 'submitted' || e.status === 'approved');
                    const hrs = es.reduce((a, e) => a + Number(e.hours), 0);
                    const st = es[0]?.status;
                    return (
                      <td key={d} className="num" title={es.map((e) => e.reject_reason).filter(Boolean).join('; ')}>
                        {locked ? <><span>{fmtNumber(hrs, lang)}</span> <StatusBadge value={st} /></> : (
                          <input type="number" min={0} max={24} step={0.5} defaultValue={hrs || ''} key={`${l.key}-${d}-${hrs}`}
                            style={{ borderColor: st === 'rejected' ? 'var(--danger)' : undefined }}
                            onBlur={(e) => { if (Number(e.target.value || 0) !== hrs) void setHours(l, d, e.target.value); }} />
                        )}
                      </td>
                    );
                  })}
                  <td className="num total">{fmtNumber(total, lang)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot><tr>
            <td colSpan={2}>{t('a.total')}</td>
            {days.map((d) => <td key={d} className="num" style={{ color: dayTotal(d) > 8 ? 'var(--warn)' : undefined }}>{fmtNumber(dayTotal(d), lang)}</td>)}
            <td className="num">{fmtNumber(weekTotal, lang)}</td>
          </tr></tfoot>
        </table>
      </div>
      <div className="card-body row" style={{ borderTop: '1px solid var(--line)' }}>
        <div style={{ width: 260 }}><RefSelect refDef={REF.project} value={newProject} onChange={(v) => { setNewProject(v as string); setNewActivity(null); }} placeholder={t('f.project')} /></div>
        <div style={{ width: 320 }}><RefSelect refDef={REF.activity} row={{ project_id: newProject }} value={newActivity} disabled={!newProject}
          onChange={(v) => setNewActivity(v as string)} placeholder={t('f.activity')} /></div>
        <button className="btn" disabled={!newProject} onClick={async () => {
          const { data: p } = await supabase.from('projects').select('code').eq('id', newProject!).single();
          const { data: a } = newActivity ? await supabase.from('activities').select('node_code, title').eq('id', newActivity).single() : { data: null };
          setExtra([...extra, { key: rowKey(newProject!, newActivity), project_id: newProject!, activity_id: newActivity,
            project_code: (p as Row)?.code, activity: a ? `${(a as Row).node_code} ${(a as Row).title}` : '' }]);
          setNewActivity(null);
        }}>+ {t('ts.addRow')}</button>
        <span className="small muted">{t('ts.hint')}</span>
      </div>
    </div>
  );
}

function ApproveList() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const { busy, run } = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [reject, setReject] = useState(false);

  const load = useCallback(async () => {
    const data = await must(supabase.from('v_timesheets').select('*').eq('status', 'submitted').order('work_date'));
    setRows(((data as Row[]) ?? []).filter((r) => r.user_id !== session?.user.id));
    setSel(new Set());
  }, [session?.user.id]);
  useEffect(() => { void load(); }, [load]);

  if (!rows) return <Spinner />;
  const decide = (decision: 'approved' | 'rejected', reason?: string) => run(async () => {
    await must(supabase.rpc('decide_timesheets', { p_ids: [...sel], p_decision: decision, p_reason: reason ?? null }));
    await load();
  }, t('ap.done'));

  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('ts.waiting')}</h3><span className="muted small">{rows.length}</span><div className="spacer" />
        <button className="btn ok" disabled={busy || !sel.size} onClick={() => decide('approved')}>✔ {t('ap.approve')} ({sel.size})</button>
        <button className="btn danger" disabled={busy || !sel.size} onClick={() => setReject(true)}>✕ {t('ap.reject')}</button>
      </div>
      {rows.length === 0 ? <Empty>{t('ts.nothing')}</Empty> : (
        <div className="table-wrap"><table className="data">
          <thead><tr>
            <th><input type="checkbox" checked={sel.size === rows.length} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
            <th>{t('f.work_date')}</th><th>{t('f.user')}</th><th>{t('f.project')}</th><th>{t('f.activity')}</th><th className="num">{t('f.hours')}</th><th>{t('f.description')}</th>
          </tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}>
              <td><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} /></td>
              <td>{fmtDate(r.work_date, lang)}</td><td>{r.user_name}</td><td className="code">{r.project_code}</td>
              <td className="small">{r.node_code} {r.activity_title}</td><td className="num">{fmtNumber(r.hours, lang)}</td><td className="small">{r.description}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {reject && <PromptDialog title={t('ap.reject')} label={t('ap.commentRequired')} required danger confirmLabel={t('ap.reject')}
        onClose={() => setReject(false)} onConfirm={(text) => decide('rejected', text)} />}
    </div>
  );
}
