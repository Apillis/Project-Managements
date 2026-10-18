// v1.2 project finance: P&L, cash flow and receivables (Finance page), invoice
// actions / payments on the invoice page, finance tab of a project.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { applyFilters, type ActiveFilters } from '../lib/query';
import { E, RESOURCES } from '../lib/resources';
import { cashflowTotals, agingSummary, AGING_BUCKETS } from '../lib/finance';
import { fmtMoney, fmtNumber, fmtPercent, isoDate } from '../lib/format';
import type { ColumnDef, Row } from '../lib/types';
import { DataTable } from '../components/DataTable';
import { FilterBar } from '../components/FilterBar';
import { ExportButton } from '../components/ExportButton';
import { RecordDrawer, ResourceTable } from '../components/Resource';
import { Empty, PageHead, PromptDialog, Spinner, Tabs, useAction } from '../components/ui';
import { useBaseCurrency } from './DocPanels';

type FTab = 'pnl' | 'cashflow' | 'receivables';

const PNL_COLS: ColumnDef[] = [
  { name: 'project_code', label: 'f.project', type: 'code' },
  { name: 'project_name', label: 'f.name' },
  { name: 'customer_name', label: 'f.customer' },
  { name: 'status', label: 'f.status', type: 'status' },
  { name: 'contract_value_base', label: 'f.contract_value_base', type: 'money', align: 'right' },
  { name: 'invoiced_base', label: 'f.invoiced_base', type: 'money', align: 'right' },
  { name: 'collected_base', label: 'f.collected_base', type: 'money', align: 'right' },
  { name: 'receivable_base', label: 'f.receivable_base', type: 'money', align: 'right' },
  { name: 'total_cost_base', label: 'f.total_cost_base', type: 'money', align: 'right' },
  { name: 'gross_margin_base', label: 'f.gross_margin_base', type: 'money', align: 'right' },
  { name: 'gross_margin_pct', label: 'f.gross_margin_pct', type: 'percent', align: 'right' },
  { name: 'net_cash_base', label: 'f.net_cash_base', type: 'money', align: 'right' },
];

const CF_COLS: ColumnDef[] = [
  { name: 'month', label: 'f.month', render: (r) => String(r.month ?? '').slice(0, 7) },
  { name: 'actual_in', label: 'f.actual_in', type: 'money', align: 'right' },
  { name: 'actual_out', label: 'f.actual_out', type: 'money', align: 'right' },
  { name: 'forecast_in', label: 'f.forecast_in', type: 'money', align: 'right' },
  { name: 'forecast_out', label: 'f.forecast_out', type: 'money', align: 'right' },
  { name: 'net_flow', label: 'f.net_flow', type: 'money', align: 'right' },
  { name: 'cumulative_net', label: 'f.cumulative_net', type: 'money', align: 'right' },
];

const AR_COLS: ColumnDef[] = [
  { name: 'doc_no', label: 'f.doc_no', type: 'code' },
  { name: 'customer_name', label: 'f.customer' },
  { name: 'project_code', label: 'f.project', type: 'code' },
  { name: 'external_ref', label: 'f.external_ref', type: 'code' },
  { name: 'invoice_date', label: 'f.invoice_date', type: 'date' },
  { name: 'due_date', label: 'f.due_date', type: 'date' },
  { name: 'balance', label: 'f.balance', type: 'money', align: 'right', currencyColumn: 'currency_code' },
  { name: 'balance_base', label: 'f.balance_base', type: 'money', align: 'right' },
  { name: 'days_overdue', label: 'f.days_overdue', type: 'number', align: 'right' },
  { name: 'aging_bucket', label: 'f.age_bucket' },
];

export function FinancePage() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const base = useBaseCurrency();
  const [sp, setSp] = useSearchParams();
  const canFinance = can('finance', 'read');
  const tab = (sp.get('tab') as FTab) || (canFinance ? 'pnl' : 'receivables');
  const [filters, setFilters] = useState<ActiveFilters>({});
  const [rows, setRows] = useState<Row[] | null>(null);

  const source = tab === 'pnl' ? 'v_project_pnl' : tab === 'cashflow' ? 'v_project_cashflow' : 'v_receivables';
  useEffect(() => {
    let alive = true;
    setRows(null);
    let q = supabase.from(source).select('*');
    q = applyFilters(q, filters, { projectColumn: 'project_id', statusColumn: tab === 'pnl' ? 'status' : undefined,
      searchColumns: tab === 'receivables' ? ['doc_no', 'customer_name', 'project_code', 'external_ref'] : ['project_code'] });
    const order = tab === 'pnl' ? 'project_code' : tab === 'cashflow' ? 'month' : 'due_date';
    q.order(order, { ascending: true, nullsFirst: false }).limit(5000)
      .then(({ data }) => { if (alive) setRows((data as Row[]) ?? []); });
    return () => { alive = false; };
  }, [source, filters, tab]);

  // without a project filter the cash flow is shown for the whole company (sum of projects per month)
  const cf = useMemo(() => (tab === 'cashflow' && rows ? cashflowTotals(rows) : []), [tab, rows]);
  const aging = useMemo(() => (tab === 'receivables' && rows ? agingSummary(rows) : null), [tab, rows]);
  const m = (v: unknown) => fmtMoney(v, lang, base || undefined);

  return (
    <>
      <PageHead title={t('nav.finance')} sub={t('fin.sub')} />
      <Tabs tabs={[
        { key: 'pnl', label: t('fin.pnl'), hidden: !canFinance },
        { key: 'cashflow', label: t('fin.cashflow'), hidden: !canFinance },
        { key: 'receivables', label: t('fin.receivables'), hidden: !can('invoices', 'read') },
      ]} value={tab} onChange={(k) => { setFilters({}); setSp({ tab: k }, { replace: true }); }} />
      <div className="card">
        <div className="card-head">
          <h3>{t(`fin.${tab}`)}</h3><span className="muted small">{base}</span><div className="spacer" />
          <ExportButton exportKey={tab === 'pnl' ? 'project_pnl' : tab === 'cashflow' ? 'project_cashflow' : 'receivables'} filters={filters} />
        </div>
        <FilterBar value={filters} onChange={setFilters} project statuses={tab === 'pnl' ? E.projectStatus : undefined} search={tab !== 'cashflow'} />
        {tab === 'receivables' && aging && (
          <div className="card-body grid cols-4" style={{ gridTemplateColumns: 'repeat(5, minmax(0, 1fr))' }}>
            {AGING_BUCKETS.map((b) => (
              <div key={b} className={`kpi ${b !== 'current' && aging[b] > 0 ? 'danger' : ''}`}>
                <div className="v" style={{ fontSize: 18 }}>{m(aging[b])}</div><div className="l">{t(`fin.aging.${b}`)}</div>
              </div>
            ))}
          </div>
        )}
        {!rows ? <Spinner /> : tab === 'pnl' ? (
          <DataTable columns={PNL_COLS} rows={rows} onRowClick={(r) => nav(`/projects/${r.project_id}?tab=cost`)}
            totals={['contract_value_base', 'invoiced_base', 'collected_base', 'receivable_base', 'total_cost_base', 'gross_margin_base', 'net_cash_base']} />
        ) : tab === 'cashflow' ? (
          filters.projectId
            ? <DataTable columns={CF_COLS} rows={rows} />
            : <DataTable columns={CF_COLS} rows={cf} empty={t('m.noData')} />
        ) : (
          <DataTable columns={AR_COLS} rows={rows} onRowClick={(r) => nav(`/r/invoices/${r.id}`)} totals={['balance_base']} />
        )}
        {tab === 'cashflow' && <div className="card-body small muted">{t('fin.cashflowHint')}</div>}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ invoice page

export function InvoiceActions({ row, view, onChanged }: { row: Row; view: Row | null; onChanged: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [cancel, setCancel] = useState(false);
  const [paying, setPaying] = useState<Row | null>(null);
  const s = row.status;
  const out: ReactNode[] = [];
  const setStatus = (patch: Row) => run(async () => {
    await must(supabase.from('invoices').update(patch).eq('id', row.id));
    onChanged();
  }, t('m.saved'));

  if (can('invoices', 'write') && s === 'draft') {
    out.push(<button key="issue" className="btn primary" disabled={busy} onClick={() => {
      if (confirm(t('inv.confirmIssue'))) void setStatus({ status: 'issued' });
    }}>✓ {t('inv.issue')}</button>);
  }
  if (can('payments', 'write') && ['issued', 'partially_paid'].includes(s)) {
    out.push(<button key="pay" className="btn ok" onClick={() => setPaying({
      direction: 'in', invoice_id: row.id, partner_id: row.customer_id, project_id: row.project_id, currency_code: row.currency_code,
      amount: view?.balance ?? null, payment_date: isoDate(), method: 'bank',
    })}>₫ {t('inv.recordPayment')}</button>);
  }
  if (can('invoices', 'write') && ['draft', 'issued'].includes(s)) {
    out.push(<button key="cancel" className="btn danger" disabled={busy} onClick={() => {
      if (s === 'draft') { if (confirm(t('m.confirmCancel'))) void setStatus({ status: 'cancelled' }); } else setCancel(true);
    }}>✕ {t('inv.cancel')}</button>);
  }
  out.push(<button key="print" className="btn" onClick={() => window.print()}>🖶 {t('a.print')}</button>);
  return (
    <>
      {out}
      {cancel && <PromptDialog title={t('inv.cancel')} label={t('inv.cancelReason')} required danger confirmLabel={t('inv.cancel')}
        onClose={() => setCancel(false)} onConfirm={(text) => setStatus({ status: 'cancelled', cancelled_reason: text })} />}
      {paying && <RecordDrawer def={RESOURCES.payments} row={paying} onClose={() => setPaying(null)}
        onSaved={() => { setPaying(null); onChanged(); }} />}
    </>
  );
}

export function InvoicePayments({ invoice, view, refreshKey }: { invoice: Row; view: Row | null; refreshKey: number }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState<Row | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!can('payments', 'read')) return;
    supabase.from('v_payments').select('*').eq('invoice_id', invoice.id).order('payment_date')
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [invoice.id, refreshKey, tick, can]);
  const cur = invoice.currency_code;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('inv.payments')}</h3><div className="spacer" />
        {view && <span className="small">{t('f.total_amount')}: <strong>{fmtMoney(view.total_amount, lang, cur)}</strong> · {t('f.paid_amount')}:{' '}
          <strong>{fmtMoney(view.paid_amount, lang, cur)}</strong> · {t('f.balance')}: <strong>{fmtMoney(view.balance, lang, cur)}</strong></span>}
      </div>
      {can('payments', 'read') ? (
        <DataTable rows={rows} onRowClick={(r) => setOpen(r)} totals={['amount']} empty={t('inv.noPayments')} columns={[
          { name: 'doc_no', label: 'f.doc_no', type: 'code' }, { name: 'payment_date', label: 'f.payment_date', type: 'date' },
          { name: 'amount', label: 'f.amount', type: 'money', align: 'right', currencyColumn: 'currency_code' },
          { name: 'method', label: 'f.method', type: 'select', enumKey: 'paymentMethod' }, { name: 'reference', label: 'f.reference' },
          { name: 'created_by_name', label: 'f.created_by' },
        ]} />
      ) : <div className="card-body small muted">{t('m.noPermission')}</div>}
      {open && <RecordDrawer def={RESOURCES.payments} row={open} onClose={() => setOpen(null)} onSaved={() => { setOpen(null); setTick(tick + 1); }} />}
    </div>
  );
}

export function MilestoneInvoiceButton({ row }: { row: Row }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  if (row.invoice_id) {
    return <button className="btn sm" onClick={() => nav(`/r/invoices/${row.invoice_id}`)}>{row.invoice_no ?? t('f.invoice')} ›</button>;
  }
  if (!can('invoices', 'write') || !['planned', 'ready'].includes(row.status)) return null;
  return (
    <button className={`btn sm ${row.status === 'ready' ? 'primary' : ''}`} disabled={busy} onClick={() => run(async () => {
      const id = await must(supabase.rpc('create_invoice_from_milestone', { p_milestone_id: row.id }));
      nav(`/r/invoices/${id}`);
    })}>₫ {t('inv.fromMilestone')}</button>
  );
}

// ------------------------------------------------------------------ project tab

export function ProjectFinance({ projectId }: { projectId: string }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const base = useBaseCurrency();
  const [r, setR] = useState<Row | null | undefined>(undefined);
  const [cf, setCf] = useState<Row[]>([]);
  useEffect(() => {
    if (!can('finance', 'read')) { setR(null); return; }
    supabase.from('v_project_pnl').select('*').eq('project_id', projectId).maybeSingle().then(({ data }) => setR((data as Row) ?? null));
    supabase.from('v_project_cashflow').select('*').eq('project_id', projectId).order('month').then(({ data }) => setCf((data as Row[]) ?? []));
  }, [projectId, can]);
  if (r === undefined) return <Spinner />;
  const m = (v: unknown) => fmtMoney(v, lang, base || undefined);
  const kpis: [string, ReactNode, string?][] = r ? [
    ['f.contract_value_base', m(r.contract_value_base)], ['f.invoiced_base', m(r.invoiced_base)],
    ['f.collected_base', m(r.collected_base)], ['f.receivable_base', m(r.receivable_base), Number(r.overdue_receivable_base) > 0 ? 'warn' : ''],
    ['f.labor_cost_base', m(r.labor_cost_base)], ['f.po_committed_base', m(r.po_committed_base)],
    ['f.freight_cost_base', m(r.freight_cost_base)], ['f.total_cost_base', m(r.total_cost_base)],
    ['f.gross_margin_base', m(r.gross_margin_base), Number(r.gross_margin_base) < 0 ? 'danger' : 'ok'],
    ['f.gross_margin_pct', fmtPercent(r.gross_margin_pct, lang)], ['f.budget_remaining_base', m(r.budget_remaining_base), Number(r.budget_remaining_base) < 0 ? 'danger' : ''],
    ['f.net_cash_base', m(r.net_cash_base), Number(r.net_cash_base) < 0 ? 'warn' : ''],
  ] : [];
  return (
    <div className="stack">
      {r && (
        <div className="card">
          <div className="card-head"><h3>{t('fin.pnl')}</h3><span className="small muted">({t('ap.base')} {base})</span><div className="spacer" />
            <ExportButton exportKey="project_pnl" filters={{ projectId }} /></div>
          <div className="card-body grid cols-4">
            {kpis.map(([k, v, tone]) => <div key={k} className={`kpi ${tone ?? ''}`}><div className="v" style={{ fontSize: 18 }}>{v}</div><div className="l">{t(k)}</div></div>)}
            <div className="kpi"><div className="v" style={{ fontSize: 18 }}>{fmtNumber(r.approved_hours, lang)}</div><div className="l">{t('f.approved_hours')}</div></div>
          </div>
        </div>
      )}
      {can('invoices', 'read') && <ResourceTable def={RESOURCES.billing_milestones} projectId={projectId} compact
        rowActions={(x) => <MilestoneInvoiceButton row={x} />} />}
      {can('invoices', 'read') && <ResourceTable def={RESOURCES.invoices} projectId={projectId} compact />}
      {r && (
        <div className="card">
          <div className="card-head"><h3>{t('fin.cashflow')}</h3><div className="spacer" /><ExportButton exportKey="project_cashflow" filters={{ projectId }} /></div>
          {cf.length ? <DataTable columns={CF_COLS} rows={cf} /> : <Empty />}
          <div className="card-body small muted">{t('fin.cashflowHint')}</div>
        </div>
      )}
      {!r && !can('invoices', 'read') && <Empty>{t('m.noPermission')}</Empty>}
    </div>
  );
}
