import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { EXPORTS, EXPORT_MODULES, type ExportSpec } from '../lib/exports';
import { IMPORTS, neededLookups, validateRows, type ImportKey, type Lookups, type ValidationResult } from '../lib/importer';
import type { ActiveFilters } from '../lib/query';
import { REF } from '../lib/resources';
import type { Row } from '../lib/types';
import { useExporter } from '../components/ExportButton';
import { FilterBar } from '../components/FilterBar';
import { RefSelect } from '../components/Form';
import { PageHead, Tabs, useAction } from '../components/ui';
import { useSearchParams } from 'react-router';
import { MappedImport } from './MappedImport';
import type { MappedImportKey } from '../lib/mappedImport';

const MAPPED: { key: MappedImportKey; resource: string }[] = [
  { key: 'structure_bom', resource: 'bom' },
  { key: 'ecount_items', resource: 'items' },
];

export function ExportCenter() {
  const { t } = useI18n();
  const { can } = useAuth();
  const visible = EXPORTS.filter((e) => can(e.resource, 'read'));
  const modules = EXPORT_MODULES.filter((m) => visible.some((e) => e.module === m));
  const [mod, setMod] = useState<string>(modules[0] ?? 'projects');
  const [spec, setSpec] = useState<ExportSpec | null>(null);
  const [filters, setFilters] = useState<ActiveFilters>({});
  const { busy, exportSpec } = useExporter();

  useEffect(() => { setSpec(null); setFilters({}); }, [mod]);

  return (
    <>
      <PageHead title={t('nav.exports')} sub={t('xc.sub')} />
      <Tabs tabs={modules.map((m) => ({ key: m, label: t(`mod.${m}`) }))} value={mod as typeof modules[number]} onChange={setMod} />
      <div className="grid cols-2">
        <div className="card">
          <div className="card-head"><h3>{t('xc.reports')}</h3></div>
          <div className="card-body stack" style={{ gap: 8 }}>
            {visible.filter((e) => e.module === mod).map((e) => (
              <div key={e.key} className={`card`} style={{ padding: 12, cursor: 'pointer', outline: spec?.key === e.key ? '2px solid var(--brand)' : undefined }}
                onClick={() => { setSpec(e); setFilters({}); }}>
                <div className="row"><strong>{t(e.title)}</strong><span className={`badge ${e.kind === 'analysis' ? 'purple' : 'blue'}`}>{t(`xc.${e.kind}`)}</span></div>
                <div className="small muted" style={{ marginTop: 4 }}>{t(e.purpose)}</div>
              </div>
            ))}
            {visible.length === 0 && <div className="muted">{t('m.noPermission')}</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h3>{spec ? t(spec.title) : t('xc.pick')}</h3></div>
          {spec && (
            <>
              <FilterBar value={filters} onChange={setFilters} search={false} project={!!spec.projectColumn}
                statuses={spec.statuses} date={!!spec.dateColumn}
                statusEnumKey={spec.statusColumn === 'move_type' ? 'moveType' : 'status'} />
              <div className="card-body stack">
                <div className="small muted">{t('xc.columns')}: {spec.columns.map((c) => t(c.label)).join(', ')}</div>
                {spec.dateColumn && <div className="small muted">{t('xc.dateField')}: {t(`f.${spec.dateColumn}`)}</div>}
                <div><button className="btn primary" disabled={busy} onClick={() => exportSpec(spec, filters)}>⬇ {busy ? t('m.exporting') : t('a.exportExcel')}</button></div>
                <div className="small muted">{t('xc.rlsNote')}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

const LOOKUP_SOURCES: Record<string, { table: string; key: string; value: string }> = {
  partner: { table: 'partners', key: 'code', value: 'id' },
  item: { table: 'items', key: 'sku', value: 'id' },
  profile: { table: 'profiles', key: 'email', value: 'id' },
  location: { table: 'locations', key: 'code', value: 'id' },
  project: { table: 'projects', key: 'code', value: 'id' },
  currency: { table: 'currencies', key: 'code', value: 'code' },
};

async function loadLookups(names: string[]): Promise<Lookups> {
  const out: Lookups = {};
  for (const n of names) {
    const s = LOOKUP_SOURCES[n];
    const map = new Map<string, string>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from(s.table).select(`${s.key},${s.value}`).range(from, from + 999);
      if (error) throw error;
      for (const r of (data as unknown as Row[]) ?? []) map.set(String(r[s.key]).toLowerCase(), String(r[s.value]));
      if (!data || data.length < 1000) break;
    }
    out[n as keyof Lookups] = map;
  }
  return out;
}

export function ImportPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [sp] = useSearchParams();
  const keys = (Object.keys(IMPORTS) as ImportKey[]).filter((k) => can(IMPORTS[k].resource, 'write'));
  const mapped = MAPPED.filter((m) => can(m.resource, 'write')).map((m) => m.key);
  const initial = sp.get('key') as ImportKey | MappedImportKey | null;
  const [tab, setTab] = useState<ImportKey | MappedImportKey>(initial && ([...keys, ...mapped] as string[]).includes(initial) ? initial : (keys[0] ?? 'partners'));
  const isMapped = (mapped as string[]).includes(tab);
  const key: ImportKey = isMapped ? (keys[0] ?? 'partners') : (tab as ImportKey);
  const [bom, setBom] = useState<string | null>(null);
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const def = IMPORTS[key];

  useEffect(() => { setResult(null); setDone(null); }, [key]);

  const template = () => run(async () => {
    const { buildTemplate, downloadWorkbook } = await import('../lib/excel');
    const wb = buildTemplate(key, def.columns.map((c) => c.name), def.columns.map((c) => (c.example ?? null) as string | number | boolean | null),
      [t('im.readme1'), t('im.readme2'), ...def.columns.map((c) => `${c.name}${c.required ? ' *' : ''}${c.options ? ' — ' + c.options.join(' | ') : ''}${c.lookup ? ' — ' + t('im.lookup') : ''}`)]);
    await downloadWorkbook(wb, `template_${key}.xlsx`);
  });

  const onFile = (f: File | undefined) => {
    if (!f) return;
    setDone(null);
    void run(async () => {
      const { readSheet } = await import('../lib/excel');
      const rows = await readSheet(await f.arrayBuffer());
      const lookups = await loadLookups(neededLookups(def));
      setResult(validateRows(def, rows, lookups));
    });
  };

  const doImport = () => run(async () => {
    if (!result?.valid.length) return;
    let payload = result.valid;
    if (def.needsBom) {
      if (!bom) throw new Error(t('im.pickBom'));
      payload = payload.map((p) => ({ ...p, bom_id: bom }));
    }
    let n = 0;
    for (let i = 0; i < payload.length; i += 500) {
      const chunk = payload.slice(i, i + 500);
      if (def.conflict) await must(supabase.from(def.table).upsert(chunk, { onConflict: def.conflict }));
      else await must(supabase.from(def.table).insert(chunk));
      n += chunk.length;
    }
    setDone(n);
    setResult(null);
  }, t('im.done'));

  if (!keys.length && !mapped.length) return <><PageHead title={t('nav.import')} /><div className="card"><div className="empty">{t('m.noPermission')}</div></div></>;

  return (
    <>
      <PageHead title={t('nav.import')} sub={t('im.sub')} />
      <Tabs<ImportKey | MappedImportKey> tabs={[...mapped, ...keys].map((k) => ({ key: k, label: t(`im.${k}`) }))} value={tab} onChange={setTab} />
      {isMapped && <MappedImport importKey={tab as MappedImportKey} presetBom={sp.get('bom')} />}
      {!isMapped && <div className="card">
        <div className="card-body stack">
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>{t('im.step1')} <button className="btn sm" disabled={busy} onClick={template}>⬇ {t('im.template')}</button></li>
            <li>{t('im.step2')}</li>
            <li>{t('im.step3')}</li>
          </ol>
          {def.needsBom && (
            <label className="field" style={{ maxWidth: 420 }}>{t('im.targetBom')}
              <RefSelect refDef={{ ...REF.bomOfProject, where: { status: 'draft' }, whereFrom: undefined }} value={bom} onChange={(v) => setBom(v as string)} />
            </label>
          )}
          <label className="field" style={{ maxWidth: 420 }}>{t('im.file')}<input type="file" accept=".xlsx" onChange={(e) => onFile(e.target.files?.[0])} /></label>
          {def.conflict && <div className="small muted">{t('im.upsertNote', { key: def.conflict })}</div>}
          {result && (
            <div className="stack">
              <div className="row">
                <span className="badge green">{t('im.valid', { n: result.valid.length })}</span>
                <span className={`badge ${result.errors.length ? 'red' : 'gray'}`}>{t('im.invalid', { n: result.errors.length })}</span>
                <div style={{ flex: 1 }} />
                <button className="btn primary" disabled={busy || !result.valid.length || (def.needsBom && !bom)} onClick={doImport}>
                  ⬆ {t('im.import', { n: result.valid.length })}
                </button>
              </div>
              {result.errors.length > 0 && (
                <table className="data"><thead><tr><th>{t('im.row')}</th><th>{t('im.errors')}</th></tr></thead>
                  <tbody>{result.errors.slice(0, 200).map((e) => <tr key={e.row}><td>{e.row}</td><td className="small">{e.messages.join(' · ')}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          )}
          {done !== null && <div className="badge green" style={{ alignSelf: 'flex-start' }}>{t('im.imported', { n: done })}</div>}
        </div>
      </div>}
    </>
  );
}
