import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { newRecord, REF, RESOURCES, toPayload, validate } from '../lib/resources';
import { fmtDateTime } from '../lib/format';
import type { ResourceDef, Row } from '../lib/types';
import { ResourceTable, LinesEditor } from '../components/Resource';
import { ExportButton } from '../components/ExportButton';
import { FormGrid, RefSelect } from '../components/Form';
import { ApprovalPanel } from '../components/Approval';
import { Dialog, Empty, PageHead, Spinner, StatusBadge, useAction } from '../components/ui';
import {
  BomActions, BomAnalysis, BuildEstimateDialog, CreatePrDialog, CreateRfqDialog, EstimateActions, EstimatePanels, RfqActions, RfqPanels,
} from './DocPanels';

export function ResourceListPage() {
  const { key = '' } = useParams();
  const { t } = useI18n();
  const def = RESOURCES[key];
  if (!def) return <Empty>404</Empty>;
  return (
    <>
      <PageHead title={t(def.title)} sub={t(`mod.${def.module}`)} />
      <ResourceTable key={def.key} def={def} />
    </>
  );
}

export function AuditTrail({ table, id }: { table: string; id: string }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open || !can('audit', 'read')) return;
    supabase.from('audit_log').select('*').eq('table_name', table).eq('row_id', id).order('changed_at', { ascending: false }).limit(100)
      .then(async ({ data }) => {
        const list = (data as Row[]) ?? [];
        setRows(list);
        const ids = Array.from(new Set(list.map((r) => r.changed_by).filter(Boolean)));
        if (ids.length) {
          const { data: ps } = await supabase.from('profiles').select('id, full_name').in('id', ids);
          setNames(Object.fromEntries(((ps as Row[]) ?? []).map((p) => [p.id, p.full_name])));
        }
      });
  }, [open, table, id, can]);
  if (!can('audit', 'read')) return null;
  return (
    <div className="card">
      <div className="card-head"><h3>{t('a.history')}</h3><div className="spacer" />
        <button className="btn sm" onClick={() => setOpen(!open)}>{open ? t('a.hide') : t('a.show')}</button></div>
      {open && (
        <div className="card-body small">
          {rows.length === 0 && <span className="muted">{t('m.noData')}</span>}
          {rows.map((r) => (
            <div key={r.id} style={{ borderBottom: '1px dashed var(--line)', padding: '6px 0' }}>
              <strong>{r.action}</strong> · {names[r.changed_by] ?? '—'} · {fmtDateTime(r.changed_at, lang)}
              {r.action === 'UPDATE' && r.new_data && (
                <div className="muted">{Object.entries(r.new_data as Row).map(([k, v]) => `${k}: ${JSON.stringify((r.old_data as Row)?.[k])} → ${JSON.stringify(v)}`).join(' · ')}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Header + lines + approval for approvable documents (quotation, SO, BOM, ECO, PR, PO). */
export function ResourceDetailPage() {
  const { key = '', id = '' } = useParams();
  const [sp] = useSearchParams();
  const def = RESOURCES[key];
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const isNew = id === 'new';
  const [row, setRow] = useState<Row | null>(null);
  const [view, setView] = useState<Row | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [tick, setTick] = useState(0);
  const [dialog, setDialog] = useState<null | string>(null);

  const load = useCallback(async () => {
    if (!def) return;
    if (isNew) {
      setRow(newRecord(def.fields, { projectId: sp.get('project') ?? undefined }));
      return;
    }
    const [r, v] = await Promise.all([
      must(supabase.from(def.table).select('*').eq('id', id).single()),
      def.view ? supabase.from(def.view).select('*').eq('id', id).maybeSingle() : Promise.resolve(null),
    ]);
    // set everything in one go so an edit started right after the reload is not marked clean
    setView((v?.data as Row) ?? null);
    setDirty(false);
    setRow(r as Row);
  }, [def, id, isNew, sp]);

  useEffect(() => { load().catch(() => setRow(null)); }, [load, tick]);

  if (!def) return <Empty>404</Empty>;
  if (!row) return <Spinner />;

  const status = String(row.status ?? 'draft');
  const canWrite = can(def.resource, 'write');
  const editable = canWrite && (isNew || ['draft', 'rejected'].includes(status));
  // after submission only the whitelisted header fields stay editable (DB enforces the same list)
  const partly = !editable && canWrite && !!def.openFields?.length && !['pending_approval', 'cancelled', 'closed'].includes(status);
  const formFields = partly ? def.fields.map((f) => ({ ...f, readOnly: !def.openFields!.includes(f.name) })) : def.fields;
  const label = isNew ? t('a.new') : (def.rowLabel?.({ ...view, ...row }) ?? row.doc_no ?? id);
  const next = def.nextStatuses?.[status] ?? [];

  const save = () => {
    const errs = validate(formFields, row);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void run(async () => {
      const payload = toPayload(formFields, row, isNew);
      if (isNew) {
        const created = await must(supabase.from(def.table).insert(payload).select().single());
        nav(`/r/${def.key}/${(created as Row).id}`, { replace: true });
      } else {
        await must(supabase.from(def.table).update(payload).eq('id', id));
        setTick(tick + 1);
      }
    }, t('m.saved'));
  };

  const setStatus = (s: string) => run(async () => {
    await must(supabase.from(def.table).update({ status: s }).eq('id', id));
    setTick(tick + 1);
  }, t('m.saved'));

  return (
    <>
      <PageHead title={<span className="row">{label} {!isNew && <StatusBadge value={status} />}</span>} sub={t(def.titleOne)}>
        <button className="btn" onClick={() => nav(-1)}>‹ {t('a.back')}</button>
        {(editable || partly) && <button className="btn primary" disabled={busy || (!dirty && !isNew)} onClick={save}>{t('a.save')}</button>}
        {!isNew && canWrite && status === 'draft' && !def.noDelete && (
          <button className="btn danger" disabled={busy} onClick={() => {
            if (!confirm(t('m.confirmDelete'))) return;
            void run(async () => { await must(supabase.from(def.table).delete().eq('id', id)); nav(`/r/${def.key}`); }, t('m.deleted'));
          }}>{t('a.delete')}</button>
        )}
        {!isNew && canWrite && next.map((s) => (
          <button key={s} className={`btn ${s === 'cancelled' || s === 'lost' ? 'danger' : ''}`} disabled={busy}
            onClick={() => { if (s !== 'cancelled' || confirm(t('m.confirmCancel'))) void setStatus(s); }}>
            → {t(`s.${s}`)}
          </button>
        ))}
        {!isNew && <DocActions def={def} row={row} view={view} onDialog={setDialog} />}
        {!isNew && def.key === 'boms' && <BomActions row={row} onDialog={setDialog} />}
        {!isNew && def.key === 'cost_estimates' && <EstimateActions row={row} onChanged={() => setTick(tick + 1)} />}
        {!isNew && def.key === 'rfqs' && <RfqActions row={row} onChanged={() => setTick(tick + 1)} />}
      </PageHead>

      <div className="stack">
        <div className="card"><div className="card-body">
          <FormGrid fields={formFields} row={row} setRow={(r) => { setRow(r); setDirty(true); }} errors={errors} disabled={!editable && !partly} isNew={isNew} />
          {!editable && !isNew && canWrite && def.docType && <p className="small muted" style={{ marginTop: 12 }}>{t('m.lockedDoc')}</p>}
        </div></div>
        {!isNew && row.id === id && def.key === 'cost_estimates' && <EstimatePanels est={row} view={view} editable={editable} onChanged={() => setTick(tick + 1)} refreshKey={tick} />}
        {!isNew && row.id === id && def.lines && <LinesEditor lines={def.lines} parent={row} editable={editable} resource={def.resource} onChanged={() => setTick(tick + 1)} refreshKey={tick}
          actions={def.key === 'boms' ? <ExportButton exportKey="bom_tree" filters={{ eq: { bom_id: id } }} /> : undefined} />}
        {!isNew && row.id === id && def.key === 'boms' && <BomAnalysis bom={row} refreshKey={tick} />}
        {!isNew && row.id === id && def.key === 'rfqs' && <RfqPanels rfq={row} onChanged={() => setTick(tick + 1)} refreshKey={tick} />}
        {isNew && def.lines && <div className="card"><div className="card-body muted">{t('m.saveFirst')}</div></div>}
        {!isNew && def.docType && <ApprovalPanel docType={def.docType} docId={id} status={status} resource={def.resource} onChanged={() => setTick(tick + 1)} />}
        {!isNew && <AuditTrail table={def.table} id={id} />}
      </div>

      {dialog === 'revision' && <NewRevisionDialog bom={row} onClose={() => setDialog(null)} />}
      {dialog === 'po' && <CreatePoDialog pr={row} onClose={() => setDialog(null)} />}
      {dialog === 'project' && <CreateProjectDialog so={row} onClose={() => setDialog(null)} />}
      {dialog === 'pr' && <CreatePrDialog bom={row} onClose={() => setDialog(null)} />}
      {dialog === 'rfq' && <CreateRfqDialog bom={row} onClose={() => setDialog(null)} />}
      {dialog === 'estimate' && <BuildEstimateDialog bom={{ ...view, ...row }} onClose={() => setDialog(null)} />}
    </>
  );
}

function DocActions({ def, row, view, onDialog }: { def: ResourceDef; row: Row; view: Row | null; onDialog: (d: string) => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const s = row.status;
  const out: React.ReactNode[] = [];
  if (def.key === 'boms' && s === 'approved') {
    if (can('bom', 'write')) out.push(<button key="rev" className="btn" onClick={() => onDialog('revision')}>↻ {t('act.newRevision')}</button>);
  }
  if (def.key === 'purchase_requests' && ['approved', 'partially_ordered'].includes(s) && can('po', 'write')) {
    out.push(<button key="po" className="btn" onClick={() => onDialog('po')}>🛒 {t('act.createPo')}</button>);
  }
  if (def.key === 'purchase_orders' && ['approved', 'ordered', 'partially_received'].includes(s) && can('po_receiving', 'read')) {
    out.push(<button key="rcv" className="btn" onClick={() => nav(`/warehouse/receiving?po=${row.id}`)}>⇩ {t('act.receive')}</button>);
  }
  if (def.key === 'purchase_orders' && can('po', 'read')) {
    out.push(<button key="print" className="btn" onClick={() => window.print()}>🖶 {t('a.print')}</button>);
  }
  if (def.key === 'quotations' && s === 'won' && can('sales_orders', 'write')) {
    out.push(<button key="so" className="btn" disabled={busy} onClick={() => run(async () => {
      const so = await must(supabase.from('sales_orders').insert({
        customer_id: row.customer_id, quotation_id: row.id, currency_code: row.currency_code, exchange_rate: row.exchange_rate,
        incoterm: row.incoterm, payment_terms: row.payment_terms,
      }).select().single()) as Row;
      const lines = await must(supabase.from('quotation_lines').select('*').eq('quotation_id', row.id).order('line_no')) as Row[];
      if (lines.length) {
        await must(supabase.from('sales_order_lines').insert(lines.map((l) => ({
          sales_order_id: so.id, line_no: l.line_no, item_id: l.item_id, description: l.description, qty: l.qty, uom: l.uom,
          unit_price: l.unit_price, discount_pct: l.discount_pct, tax_code: l.tax_code,
        }))));
      }
      nav(`/r/sales_orders/${so.id}`);
    })}>🗎 {t('act.createSo')}</button>);
  }
  if (def.key === 'sales_orders' && !row.project_id && ['approved', 'in_progress'].includes(s) && can('projects', 'write')) {
    out.push(<button key="prj" className="btn" onClick={() => onDialog('project')}>▦ {t('act.createProject')}</button>);
  }
  if (def.key === 'sales_orders' && row.project_id) {
    out.push(<button key="goprj" className="btn" onClick={() => nav(`/projects/${row.project_id}`)}>▦ {view?.project_code ?? t('r.project')}</button>);
  }
  return <>{out}</>;
}

function NewRevisionDialog({ bom, onClose }: { bom: Row; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [eco, setEco] = useState<string | null>(null);
  return (
    <Dialog title={t('act.newRevision')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={!eco || busy} onClick={() => run(async () => {
        const newId = await must(supabase.rpc('new_bom_revision', { p_bom_id: bom.id, p_eco_id: eco }));
        onClose(); nav(`/r/boms/${newId}`);
      })}>{t('a.create')}</button>
    </>}>
      <p className="small muted">{t('act.newRevisionHelp')}</p>
      <label className="field">{t('r.eco')}
        <RefSelect refDef={REF.approvedEco} row={{ project_id: bom.project_id }} value={eco} onChange={(v) => setEco(v as string)} />
      </label>
    </Dialog>
  );
}

function CreatePoDialog({ pr, onClose }: { pr: Row; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [vendor, setVendor] = useState<Row | null>(null);
  return (
    <Dialog title={t('act.createPo')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={!vendor || busy} onClick={() => run(async () => {
        const open = (await must(supabase.from('v_pr_lines').select('*').eq('pr_id', pr.id).gt('open_qty', 0).order('line_no')) as Row[]);
        if (!open.length) throw new Error(t('act.nothingOpen'));
        const po = await must(supabase.from('purchase_orders').insert({
          vendor_id: vendor!.id, project_id: pr.project_id, currency_code: vendor!.currency_code || undefined,
          payment_terms: vendor!.payment_terms, incoterm: vendor!.incoterm,
        }).select().single()) as Row;
        await must(supabase.from('po_lines').insert(open.map((l) => ({ po_id: po.id, pr_line_id: l.id, qty: l.open_qty, unit_price: 0 }))));
        onClose(); nav(`/r/purchase_orders/${po.id}`);
      })}>{t('a.create')}</button>
    </>}>
      <p className="small muted">{t('act.createPoHelp')}</p>
      <label className="field">{t('f.vendor')}
        <RefSelect refDef={REF.vendor} value={vendor?.id ?? null} onChange={(_v, p) => setVendor(p)} />
      </label>
    </Dialog>
  );
}

function CreateProjectDialog({ so, onClose }: { so: Row; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <Dialog title={t('act.createProject')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={!code || !name || busy} onClick={() => run(async () => {
        const p = await must(supabase.from('projects').insert({
          code: code.trim(), name: name.trim(), customer_id: so.customer_id, sales_order_id: so.id, due_date: so.delivery_date,
        }).select().single()) as Row;
        await must(supabase.from('sales_orders').update({ project_id: p.id }).eq('id', so.id));
        onClose(); nav(`/projects/${p.id}`);
      })}>{t('a.create')}</button>
    </>}>
      <div className="stack" style={{ gap: 10 }}>
        <label className="field">{t('f.project_code')}<input value={code} onChange={(e) => setCode(e.target.value)} placeholder="IPGOJE601" /><span className="help">{t('h.project_code')}</span></label>
        <label className="field">{t('f.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      </div>
    </Dialog>
  );
}
