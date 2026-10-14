import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { fetchPage, must } from '../lib/api';
import type { ActiveFilters } from '../lib/query';
import { newRecord, toPayload, validate } from '../lib/resources';
import type { FieldDef, LinesDef, ResourceDef, Row } from '../lib/types';
import { DataTable } from './DataTable';
import { FilterBar } from './FilterBar';
import { FormGrid } from './Form';
import { ExportButton } from './ExportButton';
import { Drawer, Spinner, useAction } from './ui';

const PAGE = 50;

function readFilters(key: string): ActiveFilters {
  try { return JSON.parse(sessionStorage.getItem('pm.f.' + key) ?? '{}') as ActiveFilters; } catch { return {}; }
}

/** List of a resource with filters, paging, export and create/edit. */
export function ResourceTable({ def, projectId, title, compact, onOpen, extraActions, refreshKey }: {
  def: ResourceDef;
  projectId?: string;
  title?: string;
  compact?: boolean;
  onOpen?: (row: Row) => void;
  extraActions?: ReactNode;
  refreshKey?: number;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const nav = useNavigate();
  const [filters, setFiltersState] = useState<ActiveFilters>(() => (projectId ? {} : readFilters(def.key)));
  const [sort, setSort] = useState(def.sort);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Row | null>(null);
  const [tick, setTick] = useState(0);

  const setFilters = (f: ActiveFilters) => {
    setFiltersState(f); setPage(0);
    if (!projectId) { try { sessionStorage.setItem('pm.f.' + def.key, JSON.stringify(f)); } catch { /* ignore */ } }
  };

  const effective = useMemo<ActiveFilters>(() => ({ ...filters, projectId: projectId ?? filters.projectId }), [filters, projectId]);
  const target = { projectColumn: def.projectColumn, statusColumn: def.statusColumn, dateColumn: def.dateColumn, searchColumns: def.searchColumns };

  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    fetchPage({ source: def.view ?? def.table, filters: effective, target, sort, page, pageSize: PAGE })
      .then((r) => { if (alive) { setRows(r.rows); setCount(r.count); } })
      .catch((e) => { if (alive) setError((e as Error).message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def.key, effective, sort, page, tick, refreshKey]);

  const hasDetail = !!(def.lines || def.docType || def.detailPath);
  const open = (r: Row) => {
    if (onOpen) return onOpen(r);
    if (def.detailPath) return nav(def.detailPath(r));
    if (hasDetail) return nav(`/r/${def.key}/${r.id}`);
    setEditing(r);
  };
  const canWrite = can(def.resource, 'write');
  const exportFilters = effective;

  return (
    <div className="card">
      <div className="card-head">
        <h3>{title ?? t(def.title)}</h3>
        <span className="muted small">{count}</span>
        <div className="spacer" />
        {extraActions}
        <ExportButton exportKey={def.exportKey} filters={exportFilters} />
        {canWrite && (
          <button className="btn primary" onClick={() => {
            if (def.detailPath) nav(def.detailPath({ id: 'new' }));
            else if (hasDetail && !def.noUpdate) nav(`/r/${def.key}/new${projectId ? `?project=${projectId}` : ''}`);
            else setEditing(newRecord(def.fields, { projectId }));
          }}>+ {t('a.new')}</button>
        )}
      </div>
      {!compact && (
        <FilterBar value={filters} onChange={setFilters} project={!!def.projectColumn && !projectId}
          statuses={def.statusEnum} statusEnumKey={def.statusColumn === 'status' || def.statusColumn === 'result' ? 'status' : enumKeyOf(def)}
          date={!!def.dateColumn} />
      )}
      {error && <div className="empty" style={{ color: 'var(--danger)' }}>{error}</div>}
      {loading && rows.length === 0 ? <Spinner /> : (
        <DataTable columns={def.columns} rows={rows} sort={sort} onSort={(s) => { setSort(s); setPage(0); }} onRowClick={open} />
      )}
      {count > PAGE && (
        <div className="pager">
          <button className="btn sm" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
          <span>{page * PAGE + 1}–{Math.min(count, (page + 1) * PAGE)} / {count}</span>
          <button className="btn sm" disabled={(page + 1) * PAGE >= count} onClick={() => setPage(page + 1)}>›</button>
        </div>
      )}
      {editing && (
        <RecordDrawer def={def} row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setTick(tick + 1); }} />
      )}
    </div>
  );
}

function enumKeyOf(def: ResourceDef): string | undefined {
  const col = def.columns.find((c) => c.name === def.statusColumn);
  return col?.enumKey ?? (def.statusColumn === 'market' ? 'market' : def.statusColumn === 'doc_type' ? 'docType' : undefined);
}

/** Create / edit a simple record in a side drawer. */
export function RecordDrawer({ def, row, onClose, onSaved, fields, table, title }: {
  def: Pick<ResourceDef, 'table' | 'resource' | 'fields' | 'titleOne' | 'noUpdate' | 'noDelete'> & { view?: string };
  row: Row; onClose: () => void; onSaved: (r: Row) => void; fields?: FieldDef[]; table?: string; title?: string;
}) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const fs = fields ?? def.fields;
  const tbl = table ?? def.table;
  const isNew = !row.id;
  const [data, setData] = useState<Row>(row);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [original, setOriginal] = useState<Row | null>(null);
  const canWrite = can(def.resource, 'write') && (isNew || !def.noUpdate);

  // when opened from a view row, load the real table row (views carry extra columns)
  useEffect(() => {
    if (isNew) return;
    supabase.from(tbl).select('*').eq('id', row.id).maybeSingle().then(({ data: d }) => {
      if (d) { setData({ ...(d as Row), __parent: row.__parent }); setOriginal(d as Row); }
    });
  }, [isNew, row.id, row.__parent, tbl]);

  const save = () => {
    const errs = validate(fs, data);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    void run(async () => {
      const payload = toPayload(fs, data, isNew);
      const res = isNew
        ? await must(supabase.from(tbl).insert(payload).select().single())
        : await must(supabase.from(tbl).update(payload).eq('id', row.id).select().single());
      onSaved(res as Row);
    }, t('m.saved'));
  };
  const remove = () => {
    if (!confirm(t('m.confirmDelete'))) return;
    void run(async () => {
      await must(supabase.from(tbl).delete().eq('id', row.id));
      onSaved(row);
    }, t('m.deleted'));
  };

  return (
    <Drawer title={title ?? `${isNew ? t('a.new') : t('a.edit')} · ${t(def.titleOne)}`} onClose={onClose} footer={<>
      {!isNew && canWrite && !def.noDelete && <button className="btn danger" disabled={busy} onClick={remove}>{t('a.delete')}</button>}
      <div style={{ flex: 1 }} />
      <button className="btn" onClick={onClose}>{canWrite ? t('a.cancel') : t('a.close')}</button>
      {canWrite && <button className="btn primary" disabled={busy} onClick={save}>{t('a.save')}</button>}
    </>}>
      {!isNew && !original && <Spinner />}
      {(isNew || original) && <FormGrid fields={fs} row={data} setRow={setData} errors={errors} disabled={!canWrite} isNew={isNew} />}
    </Drawer>
  );
}

/** Editable lines of a document. Editing allowed only while the parent is draft/rejected. */
export function LinesEditor({ lines, parent, editable, resource, onChanged, title, actions, refreshKey }: {
  lines: LinesDef; parent: Row; editable: boolean; resource: string; onChanged?: () => void;
  title?: string; actions?: ReactNode; refreshKey?: number;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<Row[]>([]);
  const [editing, setEditing] = useState<Row | null>(null);
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    const data = await must(supabase.from(lines.view ?? lines.table).select('*').eq(lines.fk, parent.id).order(lines.orderBy ?? 'line_no'));
    setRows((data as Row[]) ?? []);
  }, [lines, parent.id]);

  useEffect(() => { load().catch(() => setRows([])); }, [load, tick, refreshKey]);

  const fields = lines.fields;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{title ?? t('a.lines')}</h3><span className="muted small">{rows.length}</span>
        <div className="spacer" />
        {actions}
        {editable && <button className="btn primary sm" onClick={() => setEditing({ ...newRecord(fields), [lines.fk]: parent.id, __parent: parent })}>+ {t('a.addLine')}</button>}
      </div>
      <DataTable columns={lines.columns} rows={rows} totals={lines.totals}
        onRowClick={(r) => setEditing({ ...r, __parent: parent })} />
      {editing && (
        <RecordDrawer
          def={{ table: lines.table, resource, fields, titleOne: 'a.line', noUpdate: !editable, noDelete: !editable }}
          fields={[...fields, { name: lines.fk, label: 'f.parent', type: 'text', hidden: true }]}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); setTick(tick + 1); onChanged?.(); }}
        />
      )}
    </div>
  );
}
