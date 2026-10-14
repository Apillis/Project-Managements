// Import of customer Structure-BOM files and the Ecount item list with
// automatic sheet / header detection and an editable column mapping.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { REF } from '../lib/resources';
import type { Row } from '../lib/types';
import {
  colLetter, detectLayout, extractRows, matchHeaders, normUom, prepareBomTree, prepareEcountItems, unknownUoms,
  type ColumnMap, type MappedImportKey, type Mapping, type RawSheet, type RowIssue,
} from '../lib/mappedImport';
import { RefSelect } from '../components/Form';
import { useAction } from '../components/ui';

const REQUIRED: Record<MappedImportKey, string[]> = {
  structure_bom: ['description', 'qty'],
  ecount_items: ['erp_code', 'name'],
};

export function MappedImport({ importKey, presetBom }: { importKey: MappedImportKey; presetBom?: string | null }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [sheets, setSheets] = useState<RawSheet[] | null>(null);
  const [sheet, setSheet] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [map, setMap] = useState<ColumnMap>({});
  const [bom, setBom] = useState<string | null>(presetBom ?? null);
  const [currency, setCurrency] = useState('USD');
  const [createItems, setCreateItems] = useState(true);
  const [uoms, setUoms] = useState<string[]>([]);
  const [done, setDone] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    supabase.from('import_mappings').select('field, aliases, sort').eq('import_key', importKey).order('sort')
      .then(({ data }) => setMappings(((data as Mapping[]) ?? [])));
    supabase.from('uoms').select('code').then(({ data }) => setUoms(((data as Row[]) ?? []).map((r) => r.code)));
    setSheets(null); setDone(null);
  }, [importKey]);
  useEffect(() => { if (presetBom) setBom(presetBom); }, [presetBom]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setDone(null); setFileName(f.name);
    void run(async () => {
      const { readWorkbookRaw } = await import('../lib/excel');
      const s = await readWorkbookRaw(await f.arrayBuffer());
      // always use the current mapping from Settings (it may have been loaded after the page opened)
      const ms = ((await must(supabase.from('import_mappings').select('field, aliases, sort').eq('import_key', importKey).order('sort'))) as Mapping[]) ?? [];
      setMappings(ms);
      setSheets(s);
      const d = detectLayout(s, ms, REQUIRED[importKey]);
      if (!d) throw new Error(t('im.noHeader'));
      setSheet(d.sheet); setHeaderRow(d.headerRow); setMap(d.map);
    });
  };

  const changeHeader = (si: number, hr: number) => {
    setSheet(si); setHeaderRow(hr);
    if (sheets?.[si]) setMap(matchHeaders(sheets[si].rows[hr] ?? [], mappings));
  };

  const cur = sheets?.[sheet];
  const headers = useMemo(() => (cur?.rows[headerRow] ?? []).map((h) => String(h ?? '').trim()), [cur, headerRow]);
  const extracted = useMemo(() => (cur ? extractRows(cur, headerRow, map) : []), [cur, headerRow, map]);
  const bomPrep = useMemo(() => (importKey === 'structure_bom' ? prepareBomTree(extracted, currency) : null), [importKey, extracted, currency]);
  const itemPrep = useMemo(() => (importKey === 'ecount_items' ? prepareEcountItems(extracted) : null), [importKey, extracted]);
  const missingRequired = REQUIRED[importKey].filter((f) => !(f in map));
  const unitValues = bomPrep ? bomPrep.rows.map((r) => r.uom) : (itemPrep?.items.map((r) => r.uom) ?? []);
  const newUnits = uoms.length ? unknownUoms(unitValues, uoms) : [];
  const issues: RowIssue[] = [...(bomPrep?.issues ?? itemPrep?.issues ?? [])];
  if (importKey === 'ecount_items' && newUnits.length && !can('settings', 'write')) {
    issues.unshift({ row: 0, messages: [t('im.unknownUnits', { list: newUnits.join(', ') })] });
  }
  const count = bomPrep ? bomPrep.rows.filter((r) => r.level > 0).length : (itemPrep?.items.length ?? 0);
  const canImport = !!sheets && !missingRequired.length && count > 0 && (!bomPrep || (!!bom && bomPrep.issues.length === 0))
    && (importKey !== 'ecount_items' || !newUnits.length || can('settings', 'write'));

  const doBom = () => run(async () => {
    const lines = bomPrep!.rows.map(({ __row: _r, ...x }) => x);
    const n = await must(supabase.rpc('import_bom_tree', { p_bom_id: bom, p_lines: lines, p_create_items: createItems }));
    setDone(t('im.imported', { n: Number(n) }));
    setSheets(null);
    nav(`/r/boms/${bom}`);
  }, t('im.done'));

  const doItems = () => run(async () => {
    const list = itemPrep!.items;
    if (newUnits.length) await must(supabase.from('uoms').insert(newUnits.map((u) => ({ code: u, name_en: u, name_vi: u }))));
    // existing items by ERP code or by SKU = ERP code
    const codes = list.map((i) => i.erp_code);
    const existing = new Map<string, Row>();
    for (let i = 0; i < codes.length; i += 200) {
      const part = codes.slice(i, i + 200);
      const a = (await must(supabase.from('items').select('id, sku, erp_code').in('erp_code', part))) as Row[];
      const b = (await must(supabase.from('items').select('id, sku, erp_code').in('sku', part))) as Row[];
      for (const r of b) if (!existing.has(r.sku)) existing.set(r.sku, r);
      for (const r of a) existing.set(r.erp_code, r);
    }
    const base = (i: (typeof list)[number]) => {
      const p: Row = { erp_code: i.erp_code, name: i.name };
      if (i.mpn) p.mpn = i.mpn;
      if (i.description) p.description = i.description;
      if (i.uom) p.uom = normUom(i.uom);
      if (i.category) p.category = i.category;
      if (i.drawing_url) p.drawing_url = i.drawing_url;
      if (i.is_active !== undefined) p.is_active = i.is_active;
      return p;
    };
    const updates = list.filter((i) => existing.has(i.erp_code));
    const inserts = list.filter((i) => !existing.has(i.erp_code));
    const ids = new Map<string, string>();
    // group by key set so every PostgREST bulk call has uniform columns
    const groups = (rows: Row[]) => {
      const g = new Map<string, Row[]>();
      for (const r of rows) { const k = Object.keys(r).sort().join(','); g.set(k, [...(g.get(k) ?? []), r]); }
      return Array.from(g.values());
    };
    for (const grp of groups(updates.map((i) => ({ ...base(i), id: existing.get(i.erp_code)!.id, sku: existing.get(i.erp_code)!.sku })))) {
      for (let k = 0; k < grp.length; k += 500) {
        const res = (await must(supabase.from('items').upsert(grp.slice(k, k + 500), { onConflict: 'id' }).select('id, erp_code'))) as Row[];
        res.forEach((r) => ids.set(r.erp_code, r.id));
      }
    }
    for (const grp of groups(inserts.map((i) => ({ ...base(i), sku: i.erp_code, uom: normUom(i.uom) ?? 'EA' })))) {
      for (let k = 0; k < grp.length; k += 500) {
        const res = (await must(supabase.from('items').insert(grp.slice(k, k + 500)).select('id, erp_code'))) as Row[];
        res.forEach((r) => ids.set(r.erp_code, r.id));
      }
    }
    // purchase prices → price book (source "erp")
    const priced = list.filter((i) => i.unit_cost && ids.has(i.erp_code));
    let prices = 0;
    if (priced.length && can('costing', 'write')) {
      const vendors = (await must(supabase.from('partners').select('id, code, name').eq('is_vendor', true))) as Row[];
      const vmap = new Map<string, string>();
      vendors.forEach((v) => { vmap.set(String(v.name).toLowerCase(), v.id); vmap.set(String(v.code).toLowerCase(), v.id); });
      const rows = priced.map((i) => ({
        item_id: ids.get(i.erp_code), vendor_id: (i.vendor_name && vmap.get(i.vendor_name.toLowerCase())) || null,
        unit_price: i.unit_cost, currency_code: currency, source: 'erp', notes: `Ecount import ${fileName}`.trim(),
      }));
      for (let k = 0; k < rows.length; k += 500) await must(supabase.from('item_prices').insert(rows.slice(k, k + 500)));
      prices = rows.length;
    }
    setDone(t('im.itemsDone', { u: updates.length, n: inserts.length, p: prices }));
    setSheets(null);
  }, t('im.done'));

  const fields = mappings.map((m) => m.field);
  return (
    <div className="card">
      <div className="card-body stack">
        <p className="small muted" style={{ margin: 0 }}>{t(`im.${importKey}Help`)}</p>
        {importKey === 'structure_bom' && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
            <label className="field" style={{ minWidth: 320 }}>{t('im.targetBom')}
              <RefSelect refDef={{ ...REF.anyBom, whereIn: { status: ['draft', 'rejected'] }, whereFrom: undefined }} value={bom} onChange={(v) => setBom(v as string)} />
            </label>
            <label className="field">{t('im.createItems')}
              <input type="checkbox" checked={createItems} onChange={(e) => setCreateItems(e.target.checked)} />
            </label>
          </div>
        )}
        <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
          <label className="field" style={{ minWidth: 320 }}>{t('im.file')}
            <input type="file" accept=".xlsx" data-testid={`file-${importKey}`} onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <label className="field" style={{ width: 160 }}>{t('im.priceCurrency')}
            <RefSelect refDef={REF.currency} value={currency} onChange={(v) => setCurrency(String(v ?? 'USD'))} />
          </label>
        </div>

        {sheets && cur && (
          <>
            <div className="row" style={{ flexWrap: 'wrap', gap: 12 }}>
              <label className="field">{t('im.sheet')}
                <select value={sheet} onChange={(e) => changeHeader(Number(e.target.value), 0)}>
                  {sheets.map((s, i) => <option key={i} value={i}>{s.name}</option>)}
                </select>
              </label>
              <label className="field" style={{ width: 140 }}>{t('im.headerRow')}
                <input type="number" min={1} value={headerRow + 1} onChange={(e) => changeHeader(sheet, Math.max(0, Number(e.target.value) - 1))} />
              </label>
            </div>
            <details open={missingRequired.length > 0}>
              <summary className="small">{t('im.mapping')} · {Object.keys(map).length}/{fields.length}</summary>
              <table className="data" style={{ marginTop: 8 }}>
                <thead><tr><th>{t('f.field')}</th><th>{t('im.column')}</th></tr></thead>
                <tbody>
                  {fields.map((f) => (
                    <tr key={f}>
                      <td><span className="code">{f}</span>{REQUIRED[importKey].includes(f) ? ' *' : ''}</td>
                      <td>
                        <select value={map[f] ?? ''} onChange={(e) => {
                          const v = e.target.value; const next = { ...map };
                          if (v === '') delete next[f]; else next[f] = Number(v);
                          setMap(next);
                        }}>
                          <option value="">—</option>
                          {headers.map((h, i) => h ? <option key={i} value={i}>{colLetter(i)} · {h}</option> : null)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
            {missingRequired.length > 0 && <div className="badge red">{t('im.missingColumns', { list: missingRequired.join(', ') })}</div>}

            <div className="row">
              <span className="badge green">{t('im.valid', { n: count })}</span>
              {bomPrep && <span className="badge gray">{t('im.levels', { n: bomPrep.maxLevel })}</span>}
              {bomPrep?.top && <span className="badge gray">{t('im.top')}: {String(bomPrep.top.customer_part_no ?? bomPrep.top.description)}</span>}
              <span className={`badge ${issues.length ? 'red' : 'gray'}`}>{t('im.invalid', { n: issues.length })}</span>
              {newUnits.length > 0 && <span className="badge amber">{t('im.newUnits', { list: newUnits.join(', ') })}</span>}
              <div style={{ flex: 1 }} />
              <button className="btn primary" disabled={busy || !canImport} onClick={importKey === 'structure_bom' ? doBom : doItems}>
                ⬆ {t('im.import', { n: count })}
              </button>
            </div>
            {issues.length > 0 && (
              <table className="data"><thead><tr><th>{t('im.row')}</th><th>{t('im.errors')}</th></tr></thead>
                <tbody>{issues.slice(0, 200).map((e, i) => <tr key={i}><td>{e.row || ''}</td><td className="small">{e.messages.join(' · ')}</td></tr>)}</tbody>
              </table>
            )}
            {bomPrep && (
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="data">
                  <thead><tr><th>{t('f.level')}</th><th>{t('f.find_no')}</th><th>{t('f.customer_part_no')}</th><th>{t('f.erp_code')}</th>
                    <th>{t('f.description')}</th><th className="num">{t('f.qty_per')}</th><th>{t('f.uom')}</th><th>{t('f.part_type')}</th></tr></thead>
                  <tbody>{bomPrep.rows.slice(0, 300).map((r) => (
                    <tr key={r.key}>
                      <td>{r.level}</td><td>{String(r.find_no ?? '')}</td>
                      <td><span style={{ paddingLeft: Math.max(0, r.level - 1) * 14 }}>{String(r.customer_part_no ?? '')}</span></td>
                      <td>{String(r.erp_code ?? '')}</td><td>{String(r.description ?? '')}</td>
                      <td className="num">{String(r.qty ?? '')}</td><td>{String(r.uom ?? '')}</td><td>{String(r.part_type ?? '')}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
            {itemPrep && (
              <div className="table-wrap" style={{ maxHeight: 360 }}>
                <table className="data">
                  <thead><tr><th>{t('f.erp_code')}</th><th>{t('f.name')}</th><th>{t('f.mpn')}</th><th>{t('f.uom')}</th>
                    <th>{t('f.vendor')}</th><th className="num">{t('f.unit_cost')}</th></tr></thead>
                  <tbody>{itemPrep.items.slice(0, 300).map((r) => (
                    <tr key={r.erp_code}><td>{r.erp_code}</td><td>{r.name}</td><td>{r.mpn ?? ''}</td><td>{r.uom ?? ''}</td>
                      <td>{r.vendor_name ?? ''}</td><td className="num">{r.unit_cost ?? ''}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </>
        )}
        {done && <div className="badge green" style={{ alignSelf: 'flex-start' }}>{done}</div>}
      </div>
    </div>
  );
}
