import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { applyFilters, type ActiveFilters } from '../lib/query';
import { REF, RESOURCES, newRecord } from '../lib/resources';
import { fmtDate, fmtNumber, isoDate } from '../lib/format';
import type { ColumnDef, Row } from '../lib/types';
import { DataTable } from '../components/DataTable';
import { FilterBar } from '../components/FilterBar';
import { RefSelect } from '../components/Form';
import { RecordDrawer } from '../components/Resource';
import { ExportButton } from '../components/ExportButton';
import { Empty, PageHead, Spinner, Tabs, useAction } from '../components/ui';

interface Draft { qty: string; location: string | null; lot: string; serial: string; inspect: boolean }

export function ReceivingPage() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { busy, run } = useAction();
  const [poId, setPoId] = useState<string | null>(sp.get('po'));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [defLoc, setDefLoc] = useState<string | null>(null);

  useEffect(() => {
    supabase.from('locations').select('id, code').eq('code', 'RECV').limit(1).maybeSingle().then(({ data }) => setDefLoc((data as Row)?.id ?? null));
  }, []);

  const load = useCallback(async () => {
    let q = supabase.from('v_po_receiving').select('*').gt('open_qty', 0).in('po_status', ['approved', 'ordered', 'partially_received']);
    if (poId) q = q.eq('po_id', poId);
    const data = (await must(q.order('promised_date', { ascending: true, nullsFirst: false }).limit(300))) as Row[];
    setRows(data ?? []);
    setDrafts({});
  }, [poId]);
  useEffect(() => { void load(); }, [load]);

  const d = (id: string, r: Row): Draft => drafts[id] ?? { qty: String(r.open_qty), location: defLoc, lot: '', serial: '', inspect: true };
  const setD = (id: string, r: Row, patch: Partial<Draft>) => setDrafts({ ...drafts, [id]: { ...d(id, r), ...patch } });

  const receive = (r: Row) => run(async () => {
    const x = d(r.po_line_id, r);
    const qty = Number(x.qty);
    if (!qty || qty <= 0) throw new Error(t('rc.qtyRequired'));
    if (!x.location) throw new Error(t('rc.locationRequired'));
    const mv = await must(supabase.from('stock_moves').insert({
      move_type: 'receipt', item_id: r.item_id, qty, to_location_id: x.location, po_line_id: r.po_line_id,
      lot_no: x.lot || null, serial_no: x.serial || null, reference: r.po_no,
    }).select().single()) as Row;
    if (x.inspect && can('qa', 'write')) {
      await must(supabase.from('inspections').insert({
        inspection_type: 'incoming', project_id: r.project_id, po_line_id: r.po_line_id, item_id: r.item_id,
        stock_move_id: mv.id, qty_inspected: qty, result: 'pending',
      }));
    }
    await load();
  }, t('rc.received'));

  return (
    <>
      <PageHead title={t('nav.receiving')} sub={t('rc.sub')}>
        <div style={{ width: 280 }}>
          {/* v_po_receiving_docs: the warehouse has no right on purchase_orders (prices) */}
          <RefSelect refDef={{ ...REF.poReceivingDoc, whereIn: { po_status: ['approved', 'ordered', 'partially_received'] } }}
            value={poId} onChange={(v) => setPoId((v as string) || null)} placeholder={t('rc.filterPo')} />
        </div>
        <ExportButton exportKey="po_receiving" filters={{}} />
      </PageHead>
      <div className="card">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty>{t('rc.nothing')}</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr>
              <th>{t('f.po')}</th><th>{t('f.vendor')}</th><th>{t('f.project')}</th><th>{t('f.item')}</th>
              <th className="num">{t('f.open_qty')}</th><th>{t('f.promised_date')}</th><th style={{ width: 90 }}>{t('f.qty')}</th>
              <th style={{ width: 170 }}>{t('f.location')}</th><th>{t('f.lot_no')} / {t('f.serial_no')}</th><th>{t('rc.inspect')}</th><th />
            </tr></thead>
            <tbody>{rows.map((r) => {
              const x = d(r.po_line_id, r);
              return (
                <tr key={r.po_line_id}>
                  <td className="code">{r.po_no}</td><td>{r.vendor_name}</td><td className="code">{r.project_code}</td>
                  <td><span className="code">{r.sku}</span><div className="small">{r.description}</div></td>
                  <td className="num">{fmtNumber(r.open_qty, lang)} {r.uom}</td>
                  <td className="nowrap">{fmtDate(r.promised_date, lang)}</td>
                  <td><input type="number" min={0} value={x.qty} onChange={(e) => setD(r.po_line_id, r, { qty: e.target.value })} /></td>
                  <td><RefSelect refDef={REF.location} value={x.location} onChange={(v) => setD(r.po_line_id, r, { location: v as string })} /></td>
                  <td>
                    {r.track_lot && <input placeholder={t('f.lot_no')} value={x.lot} onChange={(e) => setD(r.po_line_id, r, { lot: e.target.value })} />}
                    {r.track_serial && <input placeholder={t('f.serial_no')} value={x.serial} onChange={(e) => setD(r.po_line_id, r, { serial: e.target.value, qty: '1' })} />}
                    {!r.track_lot && !r.track_serial && <span className="muted small">—</span>}
                  </td>
                  <td className="center"><input type="checkbox" checked={x.inspect} disabled={!can('qa', 'write')} onChange={(e) => setD(r.po_line_id, r, { inspect: e.target.checked })} /></td>
                  <td><button className="btn primary sm" disabled={busy || !can('warehouse', 'write')} onClick={() => receive(r)}>⇩ {t('rc.receive')}</button></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

interface IssueDraft { qty: string; location: string | null; bucket: 'project' | 'general'; lot: string; serial: string }

/** Issue stock against approved material requests (SRS: "issued based on approved PMO requests"). */
export function IssuePage() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const { busy, run } = useAction();
  const [mrId, setMrId] = useState<string | null>(sp.get('mr'));
  const [rows, setRows] = useState<Row[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, IssueDraft>>({});

  const load = useCallback(async () => {
    let q = supabase.from('v_material_request_lines').select('*').gt('open_qty', 0).in('mr_status', ['approved', 'partially_issued']);
    if (mrId) q = q.eq('mr_id', mrId);
    const data = (await must(q.order('needed_by', { ascending: true, nullsFirst: false }).order('mr_no').order('line_no').limit(300))) as Row[];
    setRows(data ?? []);
    setDrafts({});
  }, [mrId]);
  useEffect(() => { void load(); }, [load]);

  const d = (r: Row): IssueDraft => drafts[r.id] ?? {
    qty: String(Math.min(Number(r.open_qty), Number(r.project_stock) > 0 ? Number(r.project_stock) : Number(r.free_stock)) || r.open_qty),
    location: null, bucket: Number(r.project_stock) > 0 ? 'project' : 'general', lot: '', serial: '',
  };
  const setD = (r: Row, patch: Partial<IssueDraft>) => setDrafts({ ...drafts, [r.id]: { ...d(r), ...patch } });

  const issue = (r: Row) => run(async () => {
    const x = d(r);
    const qty = Number(x.qty);
    if (!qty || qty <= 0) throw new Error(t('rc.qtyRequired'));
    if (!x.location) throw new Error(t('rc.locationRequired'));
    await must(supabase.from('stock_moves').insert({
      move_type: 'issue', item_id: r.item_id, qty, from_location_id: x.location, mr_line_id: r.id,
      project_id: x.bucket === 'project' ? r.project_id : null, lot_no: x.lot || null, serial_no: x.serial || null,
    }));
    await load();
  }, t('is.issued'));

  return (
    <>
      <PageHead title={t('nav.issue')} sub={t('is.sub')}>
        <div style={{ width: 280 }}>
          <RefSelect refDef={REF.mrOpen} value={mrId} onChange={(v) => setMrId((v as string) || null)} placeholder={t('is.filterMr')} />
        </div>
        <ExportButton exportKey="material_requests" filters={{ statuses: ['approved', 'partially_issued'] }} />
      </PageHead>
      <div className="card">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty>{t('is.nothing')}</Empty> : (
          <div className="table-wrap"><table className="data">
            <thead><tr>
              <th>{t('r.material_request')}</th><th>{t('f.project')}</th><th>{t('f.needed_by')}</th><th>{t('f.item')}</th>
              <th className="num">{t('f.open_qty')}</th><th className="num">{t('f.project_stock')}</th><th className="num">{t('f.free_stock')}</th>
              <th style={{ width: 90 }}>{t('f.qty')}</th><th style={{ width: 150 }}>{t('f.stock_bucket')}</th>
              <th style={{ width: 170 }}>{t('f.from_location')}</th><th>{t('f.lot_no')} / {t('f.serial_no')}</th><th />
            </tr></thead>
            <tbody>{rows.map((r) => {
              const x = d(r);
              return (
                <tr key={r.id}>
                  <td className="code">{r.mr_no}<div className="small muted">{r.deliver_to}</div></td>
                  <td className="code">{r.project_code}</td>
                  <td className="nowrap" style={{ color: r.needed_by && r.needed_by < isoDate() ? 'var(--danger)' : undefined }}>{fmtDate(r.needed_by, lang)}</td>
                  <td><span className="code">{r.sku}</span><div className="small">{r.description}</div></td>
                  <td className="num">{fmtNumber(r.open_qty, lang)} {r.uom}</td>
                  <td className="num">{fmtNumber(r.project_stock, lang)}</td>
                  <td className="num">{fmtNumber(r.free_stock, lang)}</td>
                  <td><input type="number" min={0} value={x.qty} onChange={(e) => setD(r, { qty: e.target.value })} /></td>
                  <td><select value={x.bucket} onChange={(e) => setD(r, { bucket: e.target.value as IssueDraft['bucket'] })}>
                    <option value="project">{t('is.fromProject')}</option><option value="general">{t('st.general')}</option>
                  </select></td>
                  <td><RefSelect refDef={REF.location} value={x.location} onChange={(v) => setD(r, { location: v as string })} /></td>
                  <td>
                    {r.track_lot && <input placeholder={t('f.lot_no')} value={x.lot} onChange={(e) => setD(r, { lot: e.target.value })} />}
                    {r.track_serial && <input placeholder={t('f.serial_no')} value={x.serial} onChange={(e) => setD(r, { serial: e.target.value, qty: '1' })} />}
                    {!r.track_lot && !r.track_serial && <span className="muted small">—</span>}
                  </td>
                  <td><button className="btn primary sm" disabled={busy || !can('warehouse', 'write')} onClick={() => issue(r)}>⇧ {t('is.issue')}</button></td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

type StockTab = 'balance' | 'low' | 'aging';

export function StockPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as StockTab) || 'balance';
  const [filters, setFilters] = useState<ActiveFilters>({});
  const [rows, setRows] = useState<Row[] | null>(null);
  const [moving, setMoving] = useState<Row | null>(null);
  const [tick, setTick] = useState(0);

  const source = tab === 'low' ? 'v_low_stock' : tab === 'aging' ? 'v_inventory_aging' : 'v_stock_balance';
  useEffect(() => {
    setRows(null);
    let q = supabase.from(source).select('*');
    q = applyFilters(q, filters, { projectColumn: tab === 'low' ? undefined : 'project_id', searchColumns: ['sku', 'item_name'] });
    q.order(tab === 'aging' ? 'age_days' : tab === 'low' ? 'shortage_qty' : 'sku', { ascending: tab === 'balance' }).limit(1000)
      .then(({ data }) => setRows((data as Row[]) ?? []));
  }, [source, filters, tab, tick]);

  const cols: Record<StockTab, ColumnDef[]> = {
    balance: [
      { name: 'sku', label: 'f.sku', type: 'code' }, { name: 'item_name', label: 'f.item' }, { name: 'warehouse_code', label: 'f.warehouse' },
      { name: 'location_code', label: 'f.location' }, { name: 'project_code', label: 'f.stock_bucket', render: (r) => r.project_code ? <span className="code">{r.project_code}</span> : <span className="muted">{t('st.general')}</span> },
      { name: 'lot_no', label: 'f.lot_no' }, { name: 'serial_no', label: 'f.serial_no' },
      { name: 'qty', label: 'f.qty', type: 'number' }, { name: 'uom', label: 'f.uom' },
    ],
    low: [
      { name: 'sku', label: 'f.sku', type: 'code' }, { name: 'item_name', label: 'f.item' }, { name: 'min_stock', label: 'f.min_stock', type: 'number' },
      { name: 'free_qty', label: 'f.free_qty', type: 'number' }, { name: 'shortage_qty', label: 'f.shortage_qty', type: 'number' },
      { name: 'default_vendor', label: 'f.default_vendor' }, { name: 'lead_time_days', label: 'f.lead_time_days', type: 'number' },
    ],
    aging: [
      { name: 'sku', label: 'f.sku', type: 'code' }, { name: 'item_name', label: 'f.item' }, { name: 'location_code', label: 'f.location' },
      { name: 'project_code', label: 'f.stock_bucket', type: 'code' }, { name: 'qty', label: 'f.qty', type: 'number' },
      { name: 'last_receipt_date', label: 'f.last_receipt_date', type: 'date' }, { name: 'age_days', label: 'f.age_days', type: 'number' },
      { name: 'age_bucket', label: 'f.age_bucket' },
    ],
  };

  return (
    <>
      <PageHead title={t('nav.stock')} sub={t('st.sub')}>
        {can('warehouse', 'write') && <button className="btn primary" onClick={() => setMoving(newRecord(RESOURCES.stock_moves.fields))}>+ {t('st.newMove')}</button>}
      </PageHead>
      <Tabs tabs={[{ key: 'balance', label: t('x.stock_balance') }, { key: 'low', label: t('x.low_stock') }, { key: 'aging', label: t('x.inventory_aging') }]}
        value={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
      <div className="card">
        <div className="card-head"><h3>{t(tab === 'low' ? 'x.low_stock' : tab === 'aging' ? 'x.inventory_aging' : 'x.stock_balance')}</h3>
          <span className="muted small">{rows?.length ?? ''}</span><div className="spacer" />
          <ExportButton exportKey={tab === 'low' ? 'low_stock' : tab === 'aging' ? 'inventory_aging' : 'stock_balance'} filters={filters} />
        </div>
        <FilterBar value={filters} onChange={setFilters} project={tab !== 'low'} />
        {!rows ? <Spinner /> : <DataTable columns={cols[tab]} rows={rows} />}
      </div>
      {moving && <RecordDrawer def={RESOURCES.stock_moves} row={moving} onClose={() => setMoving(null)} onSaved={() => { setMoving(null); setTick(tick + 1); }} />}
    </>
  );
}
