// v1.1 panels shown on document detail pages: multi-level BOM (flat view,
// net requirement, import, PR / RFQ / estimate actions), cost estimate
// (A–L summary, labour, fees) and RFQ (vendors, quote comparison, award).
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { E, REF, SUB_LINES } from '../lib/resources';

const { LABOR, FEES, VENDORS } = SUB_LINES;
import { fmtMoney, fmtNumber } from '../lib/format';
import type { ColumnDef, FieldDef, Row } from '../lib/types';
import { DataTable } from '../components/DataTable';
import { LinesEditor, RecordDrawer } from '../components/Resource';
import { ExportButton } from '../components/ExportButton';
import { RefSelect } from '../components/Form';
import { Dialog, Tabs, useAction } from '../components/ui';

export function useBaseCurrency(): string {
  const [c, setC] = useState('');
  useEffect(() => {
    supabase.from('app_settings').select('value').eq('key', 'base_currency').maybeSingle()
      .then(({ data }) => setC(String((data as Row | null)?.value ?? '')));
  }, []);
  return c;
}

function useRows(source: string | null, column: string, id: string, order: string, tick: number) {
  const [rows, setRows] = useState<Row[]>([]);
  useEffect(() => {
    if (!source) return;
    let alive = true;
    supabase.from(source).select('*').eq(column, id).order(order).then(({ data }) => { if (alive) setRows((data as Row[]) ?? []); });
    return () => { alive = false; };
  }, [source, column, id, order, tick]);
  return rows;
}

// ============================================================== BOM
const FLAT_COLS: ColumnDef[] = [
  { name: 'erp_code', label: 'f.erp_code', type: 'code' },
  { name: 'sku', label: 'f.sku', type: 'code' },
  { name: 'customer_part_no', label: 'f.customer_part_no' },
  { name: 'description', label: 'f.description' },
  { name: 'mpn', label: 'f.mpn' },
  { name: 'part_type', label: 'f.part_type', type: 'select', enumKey: 'partType' },
  { name: 'per_unit_qty', label: 'f.qty_per_unit', type: 'number', align: 'right' },
  { name: 'required_qty', label: 'f.required_qty', type: 'number', align: 'right' },
  { name: 'uom', label: 'f.uom', width: 60 },
  { name: 'find_nos', label: 'f.find_nos' },
];
const NET_COLS: ColumnDef[] = [
  { name: 'find_no', label: 'f.find_no', type: 'tree' },
  { name: 'erp_code', label: 'f.erp_code', type: 'code' },
  { name: 'description', label: 'f.description' },
  { name: 'required_qty', label: 'f.required_qty', type: 'number', align: 'right' },
  { name: 'requested_qty', label: 'f.requested_qty', type: 'number', align: 'right' },
  { name: 'reserved_qty', label: 'f.reserved_qty', type: 'number', align: 'right' },
  { name: 'free_stock', label: 'f.free_stock', type: 'number', align: 'right' },
  { name: 'project_stock', label: 'f.project_stock', type: 'number', align: 'right' },
  { name: 'net_qty', label: 'f.net_qty', type: 'number', align: 'right' },
  { name: 'moq', label: 'f.moq', type: 'number', align: 'right' },
  { name: 'suggested_order_qty', label: 'f.suggested_order_qty', type: 'number', align: 'right' },
  { name: 'uom', label: 'f.uom', width: 60 },
  { name: 'lead_time_days', label: 'f.lead_time_days', type: 'number', align: 'right' },
];

/** Flat (summed by item) and net-requirement views of a BOM. */
export function BomAnalysis({ bom, refreshKey }: { bom: Row; refreshKey: number }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'flat' | 'net'>('flat');
  const flat = useRows(tab === 'flat' ? 'v_bom_flat' : null, 'bom_id', bom.id, 'sku', refreshKey);
  const net = useRows(tab === 'net' ? 'v_bom_net_requirement' : null, 'bom_id', bom.id, 'sort_path', refreshKey);
  const filters = { eq: { bom_id: bom.id } };
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('bom.analysis')}</h3><div className="spacer" />
        <ExportButton exportKey={tab === 'flat' ? 'bom_flat' : 'bom_net_requirement'} filters={filters} />
      </div>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <Tabs tabs={[{ key: 'flat', label: t('bom.flat') }, { key: 'net', label: t('bom.net') }]} value={tab} onChange={setTab} />
        <p className="small muted">{t(tab === 'flat' ? 'bom.flatHelp' : 'bom.netHelp')}</p>
      </div>
      <DataTable columns={tab === 'flat' ? FLAT_COLS : NET_COLS} rows={tab === 'flat' ? flat : net} />
    </div>
  );
}

export function BomActions({ row, onDialog }: { row: Row; onDialog: (d: string) => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const s = row.status;
  const out: ReactNode[] = [];
  if (['draft', 'rejected'].includes(s) && can('bom', 'write')) {
    out.push(<button key="imp" className="btn" onClick={() => nav(`/import?key=structure_bom&bom=${row.id}`)}>⬆ {t('act.importStructure')}</button>);
  }
  if (s === 'approved' && can('pr', 'write')) out.push(<button key="pr" className="btn" onClick={() => onDialog('pr')}>✎ {t('act.createPr')}</button>);
  if (s !== 'cancelled' && can('rfq', 'write')) out.push(<button key="rfq" className="btn" onClick={() => onDialog('rfq')}>? {t('act.createRfq')}</button>);
  if (s !== 'cancelled' && can('costing', 'write')) out.push(<button key="ce" className="btn" onClick={() => onDialog('estimate')}>∑ {t('act.buildEstimate')}</button>);
  return <>{out}</>;
}

export function CreatePrDialog({ bom, onClose }: { bom: Row; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [needed, setNeeded] = useState('');
  const [useStock, setUseStock] = useState(true);
  const [reserve, setReserve] = useState(true);
  return (
    <Dialog title={t('act.createPr')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        const id = await must(supabase.rpc('create_pr_from_bom', {
          p_bom_id: bom.id, p_needed_by: needed || null, p_use_stock: useStock, p_reserve: useStock && reserve,
        }));
        onClose(); nav(`/r/purchase_requests/${id}`);
      })}>{t('a.create')}</button>
    </>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>{t('act.createPrHelp')}</p>
        <label className="field">{t('f.needed_by')}<input type="date" value={needed} onChange={(e) => setNeeded(e.target.value)} /></label>
        <label className="row small"><input type="checkbox" checked={useStock} onChange={(e) => setUseStock(e.target.checked)} /> {t('act.useStock')}</label>
        <label className="row small"><input type="checkbox" checked={reserve} disabled={!useStock} onChange={(e) => setReserve(e.target.checked)} /> {t('act.reserveStock')}</label>
      </div>
    </Dialog>
  );
}

export function BuildEstimateDialog({ bom, onClose }: { bom: Row; onClose: () => void }) {
  const { t, te } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [qty, setQty] = useState(String(bom.build_qty ?? 1));
  const [cur, setCur] = useState('USD');
  const [markup, setMarkup] = useState('30');
  const [disc, setDisc] = useState<string[]>([]);
  return (
    <Dialog title={t('act.buildEstimate')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={busy || !(Number(qty) > 0)} onClick={() => run(async () => {
        const id = await must(supabase.rpc('build_cost_estimate', {
          p_bom_id: bom.id, p_build_qty: Number(qty), p_currency: cur, p_markup: Number(markup) || 0, p_disciplines: disc.length ? disc : null,
        }));
        onClose(); nav(`/r/cost_estimates/${id}`);
      })}>{t('a.create')}</button>
    </>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>{t('act.buildEstimateHelp')}</p>
        <label className="field">{t('f.build_qty')}<input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="field">{t('f.quote_currency')}<RefSelect refDef={REF.currency} value={cur} onChange={(v) => setCur(String(v ?? 'USD'))} /></label>
        <label className="field">{t('f.markup_material_pct')}<input type="number" min={0} value={markup} onChange={(e) => setMarkup(e.target.value)} /></label>
        <div className="field">{t('act.laborDisciplines')}
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            {E.laborDiscipline.map((d) => (
              <label key={d} className="row small"><input type="checkbox" checked={disc.includes(d)}
                onChange={(e) => setDisc(e.target.checked ? [...disc, d] : disc.filter((x) => x !== d))} /> {te('laborDiscipline', d)}</label>
            ))}
          </div>
          <span className="help">{t('act.laborDisciplinesHelp')}</span>
        </div>
      </div>
    </Dialog>
  );
}

export function CreateRfqDialog({ bom, onClose }: { bom: Row; onClose: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [vendors, setVendors] = useState<Row[]>([]);
  const [onlyMissing, setOnlyMissing] = useState(false);
  return (
    <Dialog title={t('act.createRfq')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={busy} onClick={() => run(async () => {
        let lineIds: string[] | null = null;
        if (onlyMissing) {
          // purchasable lines whose item has no valid price in the price book
          const tree = (await must(supabase.from('v_bom_tree').select('id, item_id, is_purchasable').eq('bom_id', bom.id))) as Row[];
          const items = Array.from(new Set(tree.filter((l) => l.is_purchasable && l.item_id).map((l) => l.item_id)));
          const priced = items.length
            ? new Set(((await must(supabase.from('v_item_prices').select('item_id').eq('is_valid', true).in('item_id', items))) as Row[]).map((r) => r.item_id))
            : new Set();
          lineIds = tree.filter((l) => l.is_purchasable && (!l.item_id || !priced.has(l.item_id))).map((l) => l.id);
          if (!lineIds.length) throw new Error(t('act.allPriced'));
        }
        const id = await must(supabase.rpc('create_rfq_from_bom', {
          p_bom_id: bom.id, p_line_ids: lineIds, p_vendor_ids: vendors.length ? vendors.map((v) => v.id) : null,
        }));
        onClose(); nav(`/r/rfqs/${id}`);
      })}>{t('a.create')}</button>
    </>}>
      <div className="stack" style={{ gap: 10 }}>
        <p className="small muted" style={{ margin: 0 }}>{t('act.createRfqHelp')}</p>
        <label className="row small"><input type="checkbox" checked={onlyMissing} onChange={(e) => setOnlyMissing(e.target.checked)} /> {t('act.onlyMissingPrices')}</label>
        <label className="field">{t('rfq.vendors')}
          <RefSelect refDef={REF.vendor} value={null} placeholder={t('rfq.addVendor')}
            onChange={(_v, p) => { if (p && !vendors.some((x) => x.id === p.id)) setVendors([...vendors, p]); }} />
        </label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          {vendors.map((v) => (
            <span key={v.id} className="badge blue">{v.name ?? v.code}
              <button className="btn sm" style={{ marginLeft: 4, height: 16, padding: '0 4px' }} onClick={() => setVendors(vendors.filter((x) => x.id !== v.id))}>×</button>
            </span>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

// ============================================================== cost estimate

export function CostSummary({ v, base }: { v: Row | null; base: string }) {
  const { t, lang } = useI18n();
  if (!v) return null;
  const m = (x: unknown) => fmtMoney(x, lang, base || undefined);
  const lines: [string, string, unknown, string?, boolean?][] = [
    ['B', 'ce.B', v.b_material_cost, t('ce.Bf')],
    ['C', 'ce.C', v.c_labor_cost, `${fmtNumber(v.labor_hours, lang)} h`],
    ['D', 'ce.D', v.d_apillis_cost, 'B + C'],
    ['E', 'ce.E', v.e_material_with_markup, `B × (1 + ${fmtNumber(v.markup_material_pct, lang)}%)`],
    ['F', 'ce.F', v.f_subtotal, 'E + C'],
    ['G', 'ce.G', v.g_vat, `F × ${fmtNumber(v.vat_pct, lang)}%`],
    ['H', 'ce.H', v.h_fees_logistics, t('ce.Hf')],
    ['K', 'ce.K', v.k_sale_price_base, 'F + G + H', true],
    ['L', 'ce.L', v.l_sale_price_moq_base, `K + MOQ ${m(v.moq_extra_base)}`, true],
  ];
  return (
    <div className="grid2">
      <div className="card">
        <div className="card-head"><h3>{t('ce.summary')}</h3><div className="spacer" /><span className="small muted">{base}</span></div>
        <table className="calc"><tbody>
          {lines.map(([k, label, val, f, total]) => (
            <tr key={k} className={total ? 'total' : ''}><td className="k">{k}</td><td>{t(label)}</td><td className="f">{f}</td><td className="v">{m(val)}</td></tr>
          ))}
        </tbody></table>
      </div>
      <div className="card">
        <div className="card-head"><h3>{t('ce.price')}</h3></div>
        <table className="calc"><tbody>
          <tr><td>{t('f.build_qty')}</td><td className="v">{fmtNumber(v.build_qty, lang)}</td></tr>
          <tr><td>{t('f.exchange_rate')} ({v.currency_code} → {base})</td><td className="v">{fmtNumber(v.exchange_rate, lang, 6)}</td></tr>
          <tr className="total"><td>{t('f.unit_sale_price')}</td><td className="v">{fmtMoney(v.unit_sale_price, lang, v.currency_code)}</td></tr>
          <tr className="total"><td>{t('f.total_sale_price')}</td><td className="v">{fmtMoney(v.total_sale_price, lang, v.currency_code)}</td></tr>
          <tr><td>{t('f.gross_margin_base')}</td><td className="v">{m(v.gross_margin_base)}</td></tr>
          <tr><td>{t('f.max_lead_time')}</td><td className="v">{v.max_lead_time ?? '—'}</td></tr>
          <tr><td>{t('f.missing_prices')}</td><td className="v">{Number(v.missing_prices) > 0 ? <span className="badge red">{v.missing_prices}</span> : '0'}</td></tr>
          {v.quotation_no && <tr><td>{t('f.quotation')}</td><td className="v"><a href={`/r/quotations/${v.quotation_id}`}>{v.quotation_no}</a></td></tr>}
        </tbody></table>
      </div>
    </div>
  );
}

export function EstimatePanels({ est, view, editable, onChanged, refreshKey }: { est: Row; view: Row | null; editable: boolean; onChanged: () => void; refreshKey: number }) {
  const { t } = useI18n();
  const base = useBaseCurrency();
  return (
    <>
      <CostSummary v={view} base={base} />
      <LinesEditor lines={LABOR} parent={est} editable={editable} resource="costing" title={t('ce.labor')} onChanged={onChanged} refreshKey={refreshKey} />
      <LinesEditor lines={FEES} parent={est} editable={editable} resource="costing" title={t('ce.fees')} onChanged={onChanged} refreshKey={refreshKey} />
    </>
  );
}

export function EstimateActions({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const out: ReactNode[] = [];
  out.push(<ExportButton key="x" exportKey="cost_estimate_lines" filters={{ eq: { estimate_id: row.id } }} label={t('ce.exportLines')} />);
  if (['draft', 'rejected'].includes(row.status) && can('costing', 'write')) {
    out.push(<button key="rp" className="btn" disabled={busy} onClick={() => run(async () => {
      const n = await must(supabase.rpc('refresh_cost_estimate_prices', { p_estimate_id: row.id }));
      onChanged();
      return n;
    }, t('ce.refreshed'))}>⟳ {t('act.refreshPrices')}</button>);
  }
  if (row.status === 'approved' && can('quotations', 'write')) {
    out.push(<button key="q" className="btn" disabled={busy} onClick={() => run(async () => {
      const q = await must(supabase.rpc('push_estimate_to_quotation', { p_estimate_id: row.id, p_quotation_id: null }));
      nav(`/r/quotations/${q}`);
    })}>₫ {t('act.pushQuotation')}</button>);
  }
  if (row.quotation_id) out.push(<button key="gq" className="btn" onClick={() => nav(`/r/quotations/${row.quotation_id}`)}>₫ {t('f.quotation')}</button>);
  return <>{out}</>;
}

// ============================================================== RFQ

export function RfqPanels({ rfq, onChanged, refreshKey }: { rfq: Row; onChanged: () => void; refreshKey: number }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [tick, setTick] = useState(0);
  const [vendors, setVendors] = useState<Row[]>([]);
  const [quote, setQuote] = useState<Row | null>(null);
  const base = useBaseCurrency();
  const cmp = useRows('v_rfq_comparison', 'rfq_id', rfq.id, 'line_no', tick + refreshKey);
  const lines = useRows('rfq_lines', 'rfq_id', rfq.id, 'line_no', tick + refreshKey);
  const canWrite = can('rfq', 'write');
  const open = !['closed', 'cancelled'].includes(rfq.status);
  const quoting = canWrite && ['sent', 'quoted', 'awarded'].includes(rfq.status);

  useEffect(() => {
    supabase.from('v_rfq_vendors').select('*').eq('rfq_id', rfq.id).order('created_at')
      .then(({ data }) => setVendors((data as Row[]) ?? []));
  }, [rfq.id, tick, refreshKey]);

  const byLine = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const q of cmp) m.set(q.rfq_line_id, [...(m.get(q.rfq_line_id) ?? []), q]);
    return m;
  }, [cmp]);

  const quoteFields: FieldDef[] = [
    { name: 'rfq_line_id', label: 'f.rfq_line', type: 'ref', required: true, createOnly: true,
      ref: { table: 'rfq_lines', label: ['line_no', 'description'], search: ['description', 'mpn'], where: { rfq_id: rfq.id }, orderBy: 'line_no' } },
    { name: 'rfq_vendor_id', label: 'f.vendor', type: 'ref', required: true, createOnly: true,
      ref: { table: 'v_rfq_vendors', label: ['vendor_name', 'contact_email'], search: ['vendor_name'], where: { rfq_id: rfq.id }, orderBy: 'vendor_name' } },
    { name: 'unit_price', label: 'f.unit_price', type: 'money', min: 0, required: true },
    { name: 'currency_code', label: 'f.currency_code', type: 'ref', ref: REF.currency, required: true, default: rfq.currency_code ?? 'USD' },
    { name: 'moq', label: 'f.moq', type: 'number', min: 0, default: 0 },
    { name: 'lead_time_days', label: 'f.lead_time_days', type: 'number', min: 0 },
    { name: 'valid_until', label: 'f.valid_until', type: 'date' },
    { name: 'notes', label: 'f.notes', type: 'text', wide: true },
    { name: 'rfq_id', label: 'r.rfq', type: 'text', hidden: true },
  ];

  return (
    <>
      <VendorList rows={vendors} parent={rfq} editable={canWrite && open} onChanged={() => { setTick(tick + 1); onChanged(); }} />
      <div className="card">
        <div className="card-head">
          <h3>{t('rfq.comparison')}</h3><span className="muted small">{cmp.length}</span><div className="spacer" />
          <ExportButton exportKey="rfq_comparison" filters={{ eq: { rfq_id: rfq.id } }} />
          {quoting && <button className="btn primary sm" onClick={() => setQuote({ rfq_id: rfq.id, currency_code: rfq.currency_code ?? 'USD', moq: 0 })}>+ {t('rfq.addQuote')}</button>}
        </div>
        {!quoting && rfq.status === 'draft' && <div className="card-body small muted">{t('rfq.sendFirst')}</div>}
        <div className="table-wrap">
          <table className="data">
            <thead><tr>
              <th>#</th><th>{t('f.description')}</th><th className="num">{t('f.qty')}</th><th>{t('f.vendor')}</th>
              <th className="num">{t('f.unit_price')}</th><th className="num">{t('f.total_base')}</th><th className="num">{t('f.moq')}</th>
              <th className="num">{t('f.lead_time_days')}</th><th>{t('f.valid_until')}</th><th />
            </tr></thead>
            <tbody>
              {lines.map((l) => {
                const qs = byLine.get(l.id) ?? [];
                if (!qs.length) return (
                  <tr key={l.id}><td>{l.line_no}</td><td>{l.description}</td><td className="num">{fmtNumber(l.qty, lang)} {l.uom}</td>
                    <td colSpan={7} className="muted small">{t('rfq.noQuotes')}</td></tr>
                );
                return qs.map((q, i) => (
                  <tr key={q.quote_id} style={{ cursor: quoting ? 'pointer' : undefined }}
                    onClick={() => quoting && setQuote({ id: q.quote_id })}>
                    <td>{i === 0 ? l.line_no : ''}</td><td>{i === 0 ? l.description : ''}</td>
                    <td className="num">{i === 0 ? `${fmtNumber(l.qty, lang)} ${l.uom}` : ''}</td>
                    <td>{q.vendor_name} {q.is_awarded && <span className="badge green">{t('rfq.awarded')}</span>}</td>
                    <td className={`num ${q.price_rank === 1 ? 'best' : ''}`}>{fmtMoney(q.unit_price, lang, q.currency_code)}</td>
                    <td className="num">{fmtMoney(q.total_base, lang, base || undefined)}</td>
                    <td className="num">{fmtNumber(q.moq, lang)}</td>
                    <td className={`num ${q.lead_time_rank === 1 ? 'best' : ''}`}>{q.lead_time_days ?? ''}</td>
                    <td>{q.valid_until ?? ''}</td>
                    <td>{quoting && !q.is_awarded && (
                      <button className="btn sm" disabled={busy} onClick={(e) => {
                        e.stopPropagation();
                        void run(async () => { await must(supabase.rpc('award_rfq_quote', { p_quote_id: q.quote_id })); setTick(tick + 1); onChanged(); }, t('rfq.awardedMsg'));
                      }}>✓ {t('rfq.award')}</button>
                    )}</td>
                  </tr>
                ));
              })}
            </tbody>
          </table>
        </div>
      </div>
      {quote && (
        <RecordDrawer def={{ table: 'rfq_quotes', resource: 'rfq', fields: quoteFields, titleOne: 'rfq.quote' }} row={quote}
          onClose={() => setQuote(null)} onSaved={() => { setQuote(null); setTick(tick + 1); onChanged(); }} />
      )}
    </>
  );
}

function VendorList({ rows, parent, editable, onChanged }: { rows: Row[]; parent: Row; editable: boolean; onChanged: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<Row | null>(null);
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('rfq.vendors')}</h3><span className="muted small">{rows.length}</span><div className="spacer" />
        {editable && <button className="btn primary sm" onClick={() => setEditing({ rfq_id: parent.id })}>+ {t('rfq.addVendor')}</button>}
      </div>
      <DataTable columns={VENDORS.columns} rows={rows} onRowClick={(r) => setEditing(r)} empty={t('rfq.noVendors')} />
      {editing && (
        <RecordDrawer def={{ table: 'rfq_vendors', resource: 'rfq', fields: VENDORS.fields, titleOne: 'rfq.vendor', noUpdate: !editable, noDelete: !editable }}
          fields={[...VENDORS.fields, { name: 'rfq_id', label: 'f.parent', type: 'text', hidden: true }]}
          row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChanged(); }} />
      )}
    </div>
  );
}

export function RfqActions({ row, onChanged }: { row: Row; onChanged: () => void }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const out: ReactNode[] = [];
  if (['draft', 'sent', 'quoted'].includes(row.status) && can('rfq', 'write')) {
    out.push(<button key="send" className="btn" disabled={busy} onClick={() => run(async () => {
      const n = await must(supabase.rpc('send_rfq', { p_rfq_id: row.id }));
      onChanged();
      return n;
    }, t('rfq.sent'))}>✉ {t(row.status === 'draft' ? 'act.sendRfq' : 'act.resendRfq')}</button>);
  }
  if (['quoted', 'awarded'].includes(row.status) && can('po', 'write')) {
    out.push(<button key="po" className="btn" disabled={busy} onClick={() => run(async () => {
      const ids = (await must(supabase.rpc('create_pos_from_rfq', { p_rfq_id: row.id }))) as string[];
      if (ids.length === 1) nav(`/r/purchase_orders/${ids[0]}`);
      else { onChanged(); nav('/r/purchase_orders'); }
    }, t('rfq.posCreated'))}>🛒 {t('act.createPosFromRfq')}</button>);
  }
  if (row.bom_id) out.push(<button key="bom" className="btn" onClick={() => nav(`/r/boms/${row.bom_id}`)}>☰ {t('r.bom')}</button>);
  return <>{out}</>;
}
