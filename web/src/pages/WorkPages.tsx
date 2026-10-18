import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { DOC_ROUTE, docPath, E } from '../lib/resources';
import { fmtDate, fmtDateTime, fmtMoney } from '../lib/format';
import type { ColumnDef, Row } from '../lib/types';
import { DataTable } from '../components/DataTable';
import { Empty, PageHead, Progress, Spinner, StatusBadge, Tabs, useAction } from '../components/ui';

export { DOC_ROUTE };

async function count(table: string, apply: (q: any) => any): Promise<number | null> {
  const { count: c, error } = await apply(supabase.from(table).select('*', { count: 'exact', head: true }));
  return error ? null : c ?? 0;
}

export function Dashboard() {
  const { t } = useI18n();
  const { can, profile, session } = useAuth();
  const nav = useNavigate();
  const uid = session?.user.id;
  const [k, setK] = useState<Record<string, number | null>>({});
  const [tasks, setTasks] = useState<Row[]>([]);
  const [risky, setRisky] = useState<Row[]>([]);
  const [approvals, setApprovals] = useState<Row[]>([]);

  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const today = new Date().toISOString().slice(0, 10);
    void (async () => {
      const out: Record<string, number | null> = {};
      out.myTasks = await count('activities', (q) => q.eq('assignee_id', uid).not('status', 'in', '(done,cancelled)'));
      out.myOverdue = await count('activities', (q) => q.eq('assignee_id', uid).not('status', 'in', '(done,cancelled)').lt('planned_end', today));
      if (can('projects')) out.activeProjects = await count('projects', (q) => q.in('status', ['planning', 'active']));
      if (can('nc')) out.openNcr = await count('ncrs', (q) => q.not('status', 'in', '(closed,cancelled)'));
      if (can('warehouse')) out.lowStock = await count('v_low_stock', (q) => q);
      if (can('po')) out.latePo = await count('v_open_po_lines', (q) => q.eq('is_late', true));
      if (can('mr') && can('warehouse', 'write')) out.mrToIssue = await count('material_requests', (q) => q.in('status', ['approved', 'partially_issued']));
      if (can('logistics')) out.inTransit = await count('shipments', (q) => q.in('status', ['booked', 'in_transit']));
      if (can('invoices')) {
        out.milestonesReady = await count('billing_milestones', (q) => q.eq('status', 'ready'));
        out.overdueInvoices = await count('v_invoices', (q) => q.eq('is_overdue', true));
      }
      if (alive) setK(out);
    })();
    supabase.from('v_activities').select('*').eq('assignee_id', uid).not('status', 'in', '(done,cancelled)')
      .order('planned_end', { ascending: true, nullsFirst: false }).limit(8).then(({ data }) => setTasks((data as Row[]) ?? []));
    if (can('projects')) {
      supabase.from('v_projects').select('*').in('status', ['planning', 'active']).or('is_late.eq.true,overdue_tasks.gt.0')
        .order('overdue_tasks', { ascending: false }).limit(8).then(({ data }) => setRisky((data as Row[]) ?? []));
    }
    supabase.rpc('my_pending_approvals').then(({ data }) => setApprovals(((data as Row[]) ?? []).slice(0, 8)));
    return () => { alive = false; };
  }, [uid, can]);

  const cards: [string, string, string, string?][] = [
    ['myTasks', 'db.myTasks', '/my-tasks'],
    ['myOverdue', 'db.myOverdue', '/my-tasks', 'danger'],
    ['activeProjects', 'db.activeProjects', '/projects'],
    ['openNcr', 'db.openNcr', '/r/ncrs', 'warn'],
    ['lowStock', 'db.lowStock', '/warehouse/stock?tab=low', 'warn'],
    ['latePo', 'db.latePo', '/r/purchase_orders', 'danger'],
    ['mrToIssue', 'db.mrToIssue', '/warehouse/issue', 'warn'],
    ['inTransit', 'db.inTransit', '/r/shipments'],
    ['milestonesReady', 'db.milestonesReady', '/r/billing_milestones', 'warn'],
    ['overdueInvoices', 'db.overdueInvoices', '/finance?tab=receivables', 'danger'],
  ];
  const noRole = profile && Object.keys(k).length > 0 && !can('projects') && !can('activities');

  return (
    <>
      <PageHead title={t('db.hello', { name: profile?.full_name ?? '' })} sub={t('db.sub')} />
      {noRole && <div className="card" style={{ marginBottom: 16 }}><div className="card-body">{t('db.noRole')}</div></div>}
      <div className="grid cols-3" style={{ marginBottom: 16 }}>
        {cards.filter(([key]) => k[key] !== undefined && k[key] !== null).map(([key, label, to, tone]) => (
          <div key={key} className={`card kpi ${tone && Number(k[key]) > 0 ? tone : ''}`} style={{ cursor: 'pointer' }} onClick={() => nav(to)}>
            <div className="v">{k[key]}</div><div className="l">{t(label)}</div>
          </div>
        ))}
      </div>
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>{t('db.myTasks')}</h3><div className="spacer" /><Link to="/my-tasks">{t('a.viewAll')}</Link></div>
          <DataTable rows={tasks} onRowClick={(r) => nav(`/projects/${r.project_id}?tab=activities`)} columns={[
            { name: 'project_code', label: 'f.project', type: 'code' }, { name: 'node_code', label: 'f.node_code', type: 'code' },
            { name: 'title', label: 'f.title' }, { name: 'planned_end', label: 'f.planned_end', type: 'date' },
            { name: 'progress_pct', label: 'f.progress', type: 'progress', width: 110 },
          ]} empty={t('db.noTasks')} />
        </div>
        <div className="card">
          <div className="card-head"><h3>{t('nav.approvals')}</h3><div className="spacer" /><Link to="/approvals">{t('a.viewAll')}</Link></div>
          <DataTable rows={approvals} onRowClick={(r) => nav(docPath(r.doc_type, r.doc_id))} columns={[
            { name: 'doc_no', label: 'f.doc_no', type: 'code' }, { name: 'doc_type', label: 'f.doc_type', type: 'select', enumKey: 'docType' },
            { name: 'amount_base', label: 'f.amount_base', type: 'money', align: 'right' }, { name: 'requested_at', label: 'f.requested_at', type: 'datetime' },
          ]} empty={t('db.noApprovals')} />
        </div>
        {can('projects') && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-head"><h3>{t('db.atRisk')}</h3></div>
            <DataTable rows={risky} onRowClick={(r) => nav(`/projects/${r.id}`)} columns={[
              { name: 'code', label: 'f.project_code', type: 'code' }, { name: 'name', label: 'f.name' },
              { name: 'customer_name', label: 'f.customer' }, { name: 'due_date', label: 'f.due_date', type: 'date' },
              { name: 'progress_pct', label: 'f.progress', type: 'progress', width: 120 },
              { name: 'overdue_tasks', label: 'f.overdue_tasks', type: 'number' }, { name: 'open_ncrs', label: 'f.open_ncrs', type: 'number' },
              { name: 'status', label: 'f.status', type: 'status' },
            ]} empty={t('db.noRisk')} />
          </div>
        )}
      </div>
    </>
  );
}

export function MyTasksPage() {
  const { t, lang, te } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const { run } = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const uid = session?.user.id;

  const load = useCallback(async () => {
    if (!uid) return;
    let q = supabase.from('v_activities').select('*').eq('assignee_id', uid);
    if (!showDone) q = q.not('status', 'in', '(done,cancelled)');
    const data = await must(q.order('planned_end', { ascending: true, nullsFirst: false }));
    setRows((data as Row[]) ?? []);
  }, [uid, showDone]);
  useEffect(() => { void load(); }, [load]);

  const update = (id: string, patch: Row) => run(async () => {
    await must(supabase.from('activities').update(patch).eq('id', id));
    await load();
  }, t('m.saved'));

  if (!rows) return <Spinner />;
  return (
    <>
      <PageHead title={t('nav.myTasks')} sub={t('mt.sub')}>
        <label className="row small"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> {t('mt.showDone')}</label>
      </PageHead>
      <div className="card">
        {rows.length === 0 ? <Empty>{t('db.noTasks')}</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr>
              <th>{t('f.project')}</th><th>{t('f.node_code')}</th><th>{t('f.title')}</th><th>{t('f.planned_end')}</th>
              <th>{t('f.status')}</th><th style={{ width: 200 }}>{t('f.progress')}</th><th>{t('f.logged_hours')}</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><a href="#" onClick={(e) => { e.preventDefault(); nav(`/projects/${r.project_id}?tab=activities`); }} className="code">{r.project_code}</a></td>
                <td className="code">{r.node_code}</td>
                <td>{r.title}<div className="small muted">{[r.inputs && `I: ${r.inputs}`, r.outputs && `O: ${r.outputs}`].filter(Boolean).join(' · ')}</div></td>
                <td className="nowrap" style={{ color: r.is_overdue ? 'var(--danger)' : undefined }}>{fmtDate(r.planned_end, lang)}</td>
                <td>{r.has_children ? <StatusBadge value={r.status} /> : (
                  <select value={r.status} onChange={(e) => update(r.id, { status: e.target.value })}>
                    {E.activityStatus.map((s) => <option key={s} value={s}>{te('status', s)}</option>)}
                  </select>)}</td>
                <td>{r.has_children ? <Progress value={r.progress_pct} /> : (
                  <input type="range" min={0} max={100} step={10} defaultValue={Number(r.progress_pct)}
                    onMouseUp={(e) => update(r.id, { progress_pct: Number((e.target as HTMLInputElement).value) })}
                    onKeyUp={(e) => update(r.id, { progress_pct: Number((e.target as HTMLInputElement).value) })} />)}
                  <span className="small muted">{Math.round(Number(r.progress_pct))}%</span></td>
                <td className="num">{r.logged_hours}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function ApprovalsPage() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'mine' | 'requested' | 'all'>('mine');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [steps, setSteps] = useState<Row[]>([]);

  useEffect(() => {
    setRows(null);
    void (async () => {
      let data: Row[];
      if (tab === 'mine') data = (await must(supabase.rpc('my_pending_approvals'))) as Row[];
      else {
        let q = supabase.from('approval_requests').select('*').order('requested_at', { ascending: false }).limit(200);
        if (tab === 'requested') q = q.eq('requested_by', session?.user.id ?? '');
        data = (await must(q)) as Row[];
      }
      setRows(data ?? []);
      if (data?.length) {
        const st = await must(supabase.from('approval_steps').select('*').in('request_id', data.map((r) => r.id)).order('step_no'));
        setSteps((st as Row[]) ?? []);
      }
    })();
  }, [tab, session?.user.id]);

  const columns: ColumnDef[] = [
    { name: 'doc_no', label: 'f.doc_no', type: 'code' },
    { name: 'doc_type', label: 'f.doc_type', type: 'select', enumKey: 'docType' },
    { name: 'amount_base', label: 'f.amount_base', align: 'right', render: (r) => Number(r.amount_base) ? fmtMoney(r.amount_base, lang) : '' },
    { name: 'requested_at', label: 'f.requested_at', type: 'datetime' },
    { name: 'steps', label: 'ap.steps', render: (r) => (
      <span className="row" style={{ gap: 4 }}>{steps.filter((s) => s.request_id === r.id).map((s) => (
        <span key={s.id} title={`${s.name}${s.comment ? ' — ' + s.comment : ''}${s.decided_at ? ' · ' + fmtDateTime(s.decided_at, lang) : ''}`}>
          <StatusBadge value={s.status} /></span>))}</span>) },
    { name: 'status', label: 'f.status', type: 'status' },
  ];
  return (
    <>
      <PageHead title={t('nav.approvals')} sub={t('ap.sub')} />
      <Tabs tabs={[{ key: 'mine', label: t('ap.waitingMe') }, { key: 'requested', label: t('ap.myRequests') }, { key: 'all', label: t('ap.all') }]}
        value={tab} onChange={setTab} />
      <div className="card">
        {!rows ? <Spinner /> : <DataTable rows={rows} columns={columns} onRowClick={(r) => nav(docPath(r.doc_type, r.doc_id))} empty={t('db.noApprovals')} />}
      </div>
    </>
  );
}
