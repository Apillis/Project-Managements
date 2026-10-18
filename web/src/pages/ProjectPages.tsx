import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { E, RESOURCES, newRecord, toPayload, validate } from '../lib/resources';
import { fmtDate, fmtNumber } from '../lib/format';
import type { ColumnDef, Row } from '../lib/types';
import { ResourceTable } from '../components/Resource';
import { DataTable } from '../components/DataTable';
import { FormGrid } from '../components/Form';
import { Idef0Workspace } from '../components/Idef0';
import { DocumentsPanel } from '../components/Documents';
import { ExportButton } from '../components/ExportButton';
import { StatusPicker } from '../components/FilterBar';
import { Dialog, Empty, PageHead, Progress, Spinner, StatusBadge, Tabs, useAction } from '../components/ui';
import { closeBlockers } from '../lib/finance';
import { AuditTrail } from './ResourcePages';
import { ProjectFinance } from './FinancePages';

export function ProjectsPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHead title={t('r.projects')} sub={t('mod.projects')} />
      <ResourceTable def={RESOURCES.projects} />
    </>
  );
}

type Tab = 'overview' | 'activities' | 'schedule' | 'bom' | 'purchasing' | 'stock' | 'logistics' | 'documents' | 'quality' | 'compliance' | 'time' | 'cost';

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const [sp, setSp] = useSearchParams();
  const { t } = useI18n();
  const { can, hasRole } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [closing, setClosing] = useState(false);
  const isNew = id === 'new';
  const def = RESOURCES.projects;
  const tab = (sp.get('tab') as Tab) || (isNew ? 'overview' : 'activities');
  const [row, setRow] = useState<Row | null>(null);
  const [kpi, setKpi] = useState<Row | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (isNew) { setRow(newRecord(def.fields)); return; }
    setRow(await must(supabase.from('projects').select('*').eq('id', id).single()) as Row);
    const k = await supabase.from('v_projects').select('*').eq('id', id).maybeSingle();
    setKpi(k.data as Row);
    setDirty(false);
  }, [id, isNew, def.fields]);
  useEffect(() => { void load(); }, [load, tick]);

  if (!row) return <Spinner />;
  const canWrite = can('projects', 'write');
  const setTab = (k: Tab) => setSp({ tab: k }, { replace: true });

  const save = () => {
    const errs = validate(def.fields, row);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void run(async () => {
      const payload = toPayload(def.fields, row, isNew);
      if (isNew) {
        const p = await must(supabase.from('projects').insert(payload).select().single()) as Row;
        nav(`/projects/${p.id}?tab=activities`, { replace: true });
      } else {
        await must(supabase.from('projects').update(payload).eq('id', id));
        setTick(tick + 1);
      }
    }, t('m.saved'));
  };

  const tabs: { key: Tab; label: string; hidden?: boolean }[] = [
    { key: 'overview', label: t('pj.overview') },
    { key: 'activities', label: t('pj.activities'), hidden: isNew },
    { key: 'schedule', label: t('pj.schedule'), hidden: isNew },
    { key: 'bom', label: t('r.boms'), hidden: isNew || !can('bom') },
    { key: 'purchasing', label: t('pj.purchasing'), hidden: isNew || !(can('pr') || can('po')) },
    { key: 'stock', label: t('pj.materials'), hidden: isNew || !(can('warehouse') || can('mr')) },
    { key: 'logistics', label: t('nav.logistics'), hidden: isNew || !can('logistics') },
    { key: 'documents', label: t('r.documents'), hidden: isNew || !can('documents') },
    { key: 'quality', label: t('pj.quality'), hidden: isNew || !(can('qa') || can('nc')) },
    { key: 'compliance', label: t('r.compliance'), hidden: isNew || !can('compliance') },
    { key: 'time', label: t('nav.timesheets'), hidden: isNew },
    { key: 'cost', label: t('pj.cost'), hidden: isNew || !(can('finance') || can('invoices')) },
  ];
  const locked = ['closed', 'cancelled'].includes(row.status) && !isNew;

  return (
    <>
      <PageHead
        title={<span className="row">{isNew ? t('pj.new') : <><span className="code">{row.code}</span> {row.name}</>} {!isNew && <StatusBadge value={row.status} />}</span>}
        sub={kpi ? `${kpi.customer_name ?? ''}${kpi.pm_name ? ' · PM ' + kpi.pm_name : ''}` : t('r.project')}>
        <button className="btn" onClick={() => nav('/projects')}>‹ {t('a.back')}</button>
      </PageHead>
      {kpi && (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <div className="card kpi"><div className="l">{t('f.progress')}</div><div style={{ marginTop: 8 }}><Progress value={kpi.progress_pct} /></div></div>
          <div className={`card kpi ${Number(kpi.overdue_tasks) > 0 ? 'danger' : 'ok'}`}><div className="v">{kpi.overdue_tasks}</div><div className="l">{t('f.overdue_tasks')}</div></div>
          <div className={`card kpi ${Number(kpi.open_ncrs) > 0 ? 'warn' : 'ok'}`}><div className="v">{kpi.open_ncrs}</div><div className="l">{t('f.open_ncrs')}</div></div>
          <div className={`card kpi ${Number(kpi.open_compliance_items) > 0 ? 'warn' : 'ok'}`}><div className="v">{kpi.open_compliance_items}</div><div className="l">{t('f.open_compliance_items')}</div></div>
        </div>
      )}
      {locked && (
        <div className="card" style={{ marginBottom: 12, borderColor: 'var(--warn)' }}>
          <div className="card-body row">
            <span>🔒 {t(row.status === 'closed' ? 'pj.closedBanner' : 'pj.cancelledBanner')}</span><div className="spacer" />
            {canWrite && (hasRole('management') || hasRole('admin')) && (
              <button className="btn" disabled={busy} onClick={() => {
                if (confirm(t('pj.confirmReopen'))) void run(async () => { await must(supabase.from('projects').update({ status: 'active' }).eq('id', id)); setTick(tick + 1); }, t('m.saved'));
              }}>↺ {t('pj.reopen')}</button>
            )}
          </div>
        </div>
      )}
      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {tab === 'overview' && (
        <div className="stack">
          <div className="card">
            <div className="card-head"><h3>{t('pj.info')}</h3><div className="spacer" />
              {canWrite && !isNew && !locked && <button className="btn" disabled={busy} onClick={() => setClosing(true)}>🏁 {t('pj.close')}</button>}
              {canWrite && !locked && <button className="btn primary" disabled={busy || (!dirty && !isNew)} onClick={save}>{t('a.save')}</button>}</div>
            <div className="card-body">
              <FormGrid fields={def.fields} row={row} setRow={(r) => { setRow(r); setDirty(true); }} errors={errors} disabled={!canWrite || locked} isNew={isNew} />
            </div>
          </div>
          {!isNew && <AuditTrail table="projects" id={id} />}
        </div>
      )}
      {closing && <CloseProjectDialog project={row} onClose={() => setClosing(false)} onClosed={() => { setClosing(false); setTick(tick + 1); }} />}
      {tab === 'activities' && <Idef0Workspace projectId={id} />}
      {tab === 'schedule' && <Schedule projectId={id} />}
      {tab === 'bom' && <ResourceTable def={RESOURCES.boms} projectId={id} compact />}
      {tab === 'purchasing' && (
        <div className="stack">
          {can('pr') && <ResourceTable def={RESOURCES.purchase_requests} projectId={id} compact />}
          {can('po') && <ResourceTable def={RESOURCES.purchase_orders} projectId={id} compact />}
        </div>
      )}
      {tab === 'stock' && <ProjectMaterials projectId={id} />}
      {tab === 'logistics' && <ResourceTable def={RESOURCES.shipments} projectId={id} compact />}
      {tab === 'documents' && <DocumentsPanel projectId={id} />}
      {tab === 'quality' && (
        <div className="stack">
          {can('qa') && <ResourceTable def={RESOURCES.inspections} projectId={id} compact />}
          {can('nc') && <ResourceTable def={RESOURCES.ncrs} projectId={id} compact />}
        </div>
      )}
      {tab === 'compliance' && <ComplianceTab projectId={id} market={row.market} />}
      {tab === 'time' && <ProjectHours projectId={id} />}
      {tab === 'cost' && <ProjectFinance projectId={id} />}
    </>
  );
}

/** Simple Gantt-style schedule of the IDEF0 activities */
function Schedule({ projectId }: { projectId: string }) {
  const { t, lang, te } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [statuses, setStatuses] = useState<string[]>([]);
  useEffect(() => {
    supabase.from('v_activities').select('*').eq('project_id', projectId).order('node_code')
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [projectId]);
  const range = useMemo(() => {
    const ds = (rows ?? []).flatMap((r) => [r.planned_start, r.planned_end]).filter(Boolean).map((d: string) => new Date(d + 'T00:00:00').getTime());
    if (!ds.length) return null;
    return { min: Math.min(...ds), max: Math.max(...ds) + 86400000 };
  }, [rows]);
  if (!rows) return <Spinner />;
  const list = rows.filter((r) => !statuses.length || statuses.includes(r.status));
  const pos = (d: string) => (range ? ((new Date(d + 'T00:00:00').getTime() - range.min) / (range.max - range.min)) * 100 : 0);
  const today = range ? ((Date.now() - range.min) / (range.max - range.min)) * 100 : -1;
  const columns: ColumnDef[] = [
    { name: 'node_code', label: 'f.node_code', type: 'code', width: 70 },
    { name: 'title', label: 'f.title', width: 280, render: (r) => <span style={{ paddingLeft: Number(r.depth) * 12, fontWeight: r.has_children ? 650 : 400 }}>{r.title}{r.is_milestone ? ' ◆' : ''}</span> },
    { name: 'assignee_name', label: 'f.assignee' },
    { name: 'planned_start', label: 'f.planned_start', type: 'date' },
    { name: 'planned_end', label: 'f.planned_end', type: 'date' },
    { name: 'progress_pct', label: 'f.progress', type: 'progress', width: 130 },
    { name: 'status', label: 'f.status', type: 'status' },
    { name: 'bar', label: 'pj.timeline', width: 360, render: (r) => (r.planned_start && r.planned_end && range) ? (
      <div style={{ position: 'relative', height: 12, width: 340 }}>
        {today >= 0 && today <= 100 && <div style={{ position: 'absolute', left: `${today}%`, top: -4, bottom: -4, width: 1, background: '#e5484d' }} />}
        <div className={`gantt-bar ${r.is_overdue ? 'late' : r.status === 'done' ? 'done' : ''}`}
          title={`${fmtDate(r.planned_start, lang)} → ${fmtDate(r.planned_end, lang)}`}
          style={{ position: 'absolute', left: `${pos(r.planned_start)}%`, width: `${Math.max(pos(r.planned_end) - pos(r.planned_start), 0.8) + (100 / ((range.max - range.min) / 86400000))}%` }} />
      </div>) : null },
  ];
  return (
    <div className="card">
      <div className="card-head"><h3>{t('pj.schedule')}</h3><div className="spacer" />
        <div style={{ width: 220 }}><StatusPicker options={E.activityStatus} value={statuses} onChange={setStatuses} /></div>
        <ExportButton exportKey="activities" filters={{ projectId, statuses: statuses.length ? statuses : undefined }} />
      </div>
      <DataTable columns={columns} rows={list} />
      <div className="small muted" style={{ padding: 10 }}>{t('pj.timelineHint')} · {te('status', 'done')} / {t('f.is_overdue')}</div>
    </div>
  );
}

function ProjectMaterials({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const [bva, setBva] = useState<Row[]>([]);
  const [stock, setStock] = useState<Row[]>([]);
  useEffect(() => {
    supabase.from('v_bom_vs_actual').select('*').eq('project_id', projectId).order('sku').then(({ data }) => setBva((data as Row[]) ?? []));
    supabase.from('v_stock_balance').select('*').eq('project_id', projectId).order('sku').then(({ data }) => setStock((data as Row[]) ?? []));
  }, [projectId]);
  return (
    <div className="stack">
      {can('mr') && <ResourceTable def={RESOURCES.material_requests} projectId={projectId} compact />}
      <div className="card">
        <div className="card-head"><h3>{t('x.bom_vs_actual')}</h3><div className="spacer" /><ExportButton exportKey="bom_vs_actual" filters={{ projectId }} /></div>
        <DataTable rows={bva} columns={[
          { name: 'sku', label: 'f.sku', type: 'code' }, { name: 'description', label: 'f.description' },
          { name: 'bom_qty', label: 'f.bom_qty', type: 'number' }, { name: 'requested_qty', label: 'f.requested_qty', type: 'number' },
          { name: 'ordered_qty', label: 'f.ordered_qty', type: 'number' }, { name: 'received_qty', label: 'f.received_qty', type: 'number' },
          { name: 'consumed_qty', label: 'f.consumed_qty', type: 'number' }, { name: 'variance_qty', label: 'f.variance_qty', type: 'number' },
        ]} />
      </div>
      <div className="card">
        <div className="card-head"><h3>{t('pj.reservedStock')}</h3><div className="spacer" /><ExportButton exportKey="stock_balance" filters={{ projectId }} /></div>
        <DataTable rows={stock} columns={[
          { name: 'sku', label: 'f.sku', type: 'code' }, { name: 'item_name', label: 'f.item' },
          { name: 'location_code', label: 'f.location' }, { name: 'lot_no', label: 'f.lot_no' }, { name: 'serial_no', label: 'f.serial_no' },
          { name: 'qty', label: 'f.qty', type: 'number' }, { name: 'uom', label: 'f.uom' },
        ]} />
      </div>
    </div>
  );
}

function ComplianceTab({ projectId, market }: { projectId: string; market?: string }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [markets, setMarkets] = useState<string[]>(market && ['EU', 'US', 'CA', 'VN'].includes(market) ? [market] : ['EU']);
  const [k, setK] = useState(0);
  return (
    <div className="stack">
      {can('compliance', 'write') && (
        <div className="card"><div className="card-body row">
          <span>{t('cp.apply')}</span>
          <div style={{ width: 240 }}><StatusPicker options={['EU', 'US', 'CA', 'VN']} value={markets} onChange={setMarkets} enumKey="market" /></div>
          <button className="btn primary" disabled={busy || !markets.length} onClick={() => run(async () => {
            const n = await must(supabase.rpc('apply_compliance_templates', { p_project_id: projectId, p_markets: markets, p_lang: lang }));
            setK(k + 1);
            return n;
          }, t('cp.applied'))}>{t('cp.generate')}</button>
          <span className="small muted">{t('cp.hint')}</span>
        </div></div>
      )}
      <ResourceTable def={RESOURCES.project_compliance} projectId={projectId} refreshKey={k} />
    </div>
  );
}

function ProjectHours({ projectId }: { projectId: string }) {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  useEffect(() => {
    supabase.from('v_timesheets').select('*').eq('project_id', projectId).neq('status', 'rejected')
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [projectId]);
  if (!rows) return <Spinner />;
  const by = new Map<string, { user: string; hours: number; approved: number }>();
  for (const r of rows) {
    const e = by.get(r.user_name) ?? { user: r.user_name, hours: 0, approved: 0 };
    e.hours += Number(r.hours); if (r.status === 'approved') e.approved += Number(r.hours);
    by.set(r.user_name, e);
  }
  const list = [...by.values()].sort((a, b) => b.hours - a.hours);
  return (
    <div className="card">
      <div className="card-head"><h3>{t('pj.hours')}</h3><div className="spacer" /><ExportButton exportKey="timesheets" filters={{ projectId }} /></div>
      {list.length === 0 ? <Empty /> : (
        <table className="data"><thead><tr><th>{t('f.user')}</th><th className="num">{t('f.hours')}</th><th className="num">{t('f.approved_hours')}</th></tr></thead>
          <tbody>{list.map((r) => <tr key={r.user}><td>{r.user}</td><td className="num">{fmtNumber(r.hours, lang)}</td><td className="num">{fmtNumber(r.approved, lang)}</td></tr>)}</tbody>
        </table>
      )}
      <p className="small muted" style={{ padding: '0 16px' }}>{t('pj.hoursHint')}</p>
    </div>
  );
}

/** SRS phase 5: closure checklist, then close (all project records become read-only). */
function CloseProjectDialog({ project, onClose, onClosed }: { project: Row; onClose: () => void; onClosed: () => void }) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [rows, setRows] = useState<{ check_code: string; open_count: number }[] | null>(null);
  useEffect(() => {
    supabase.rpc('project_close_check', { p_project_id: project.id })
      .then(({ data }) => setRows((data as { check_code: string; open_count: number }[]) ?? []));
  }, [project.id]);
  const open = rows ? closeBlockers(rows) : [];
  return (
    <Dialog title={`${t('pj.close')} · ${project.code}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={busy || !rows || open.length > 0} onClick={() => run(async () => {
        await must(supabase.from('projects').update({ status: 'closed' }).eq('id', project.id));
        onClosed();
      }, t('pj.closedMsg'))}>🏁 {t('pj.close')}</button>
    </>}>
      <p className="small muted" style={{ marginTop: 0 }}>{t('pj.closeHelp')}</p>
      {!rows ? <Spinner /> : (
        <table className="data"><tbody>
          {rows.map((r) => (
            <tr key={r.check_code}>
              <td>{Number(r.open_count) > 0 ? '✕' : '✓'}</td>
              <td>{t(`close.${r.check_code}`)}</td>
              <td className="num"><span className={`badge ${Number(r.open_count) > 0 ? 'red' : 'green'}`}>{r.open_count}</span></td>
            </tr>
          ))}
        </tbody></table>
      )}
      {open.length > 0 && <p className="small" style={{ color: 'var(--danger)' }}>{t('pj.closeBlocked')}</p>}
    </Dialog>
  );
}
