import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { FILES_BUCKET, supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { E, REF, RESOURCES } from '../lib/resources';
import type { Row } from '../lib/types';
import { DataTable } from './DataTable';
import { RecordDrawer } from './Resource';
import { RefSelect } from './Form';
import { ExportButton } from './ExportButton';
import { FilterBar } from './FilterBar';
import { Drawer, useAction } from './ui';
import type { ActiveFilters } from '../lib/query';
import { applyFilters } from '../lib/query';

export function safeFileName(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .replace(/[^A-Za-z0-9._-]+/g, '_').replace(/_+/g, '_').slice(0, 120);
}

/** Document register with file upload/download (Supabase Storage). */
export function DocumentsPanel({ projectId }: { projectId?: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const def = RESOURCES.documents;
  const [rows, setRows] = useState<Row[]>([]);
  const [filters, setFilters] = useState<ActiveFilters>({});
  const [editing, setEditing] = useState<Row | null>(null);
  const [upload, setUpload] = useState(false);

  const load = useCallback(async () => {
    let q = supabase.from('v_documents').select('*');
    q = applyFilters(q, { ...filters, projectId: projectId ?? filters.projectId },
      { projectColumn: 'project_id', statusColumn: 'status', searchColumns: def.searchColumns });
    const data = await must(q.order('updated_at', { ascending: false }).limit(500));
    setRows((data as Row[]) ?? []);
  }, [filters, projectId, def.searchColumns]);
  useEffect(() => { void load(); }, [load]);

  const download = (r: Row) => run(async () => {
    const { data, error } = await supabase.storage.from(FILES_BUCKET).createSignedUrl(r.storage_path, 300, { download: r.file_name ?? true });
    if (error) throw error;
    window.open(data.signedUrl, '_blank');
  });

  const canWrite = can('documents', 'write');
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('r.documents')}</h3><span className="muted small">{rows.length}</span><div className="spacer" />
        <ExportButton exportKey="documents" filters={{ ...filters, projectId: projectId ?? filters.projectId }} />
        {canWrite && <button className="btn primary" onClick={() => setUpload(true)}>⬆ {t('doc.upload')}</button>}
      </div>
      <FilterBar value={filters} onChange={setFilters} project={!projectId} statuses={E.docStatus} />
      <DataTable columns={def.columns} rows={rows} onRowClick={(r) => setEditing(r)}
        actions={(r) => r.storage_path ? <button className="btn sm" disabled={busy} onClick={() => download(r)}>⬇ {t('doc.download')}</button> : null} />
      {editing && <RecordDrawer def={def} row={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {upload && <UploadDrawer projectId={projectId} onClose={() => setUpload(false)} onDone={() => { setUpload(false); void load(); }} />}
    </div>
  );
}

function UploadDrawer({ projectId, onClose, onDone }: { projectId?: string; onClose: () => void; onDone: () => void }) {
  const { t, te } = useI18n();
  const { busy, run } = useAction();
  const [file, setFile] = useState<File | null>(null);
  const [row, setRow] = useState<Row>({ project_id: projectId ?? null, category: 'drawing_mech', revision: 'A', title: '', doc_no: '' });

  const submit = () => run(async () => {
    if (!file) return;
    const doc = await must(supabase.from('documents').insert({
      project_id: row.project_id || null, category: row.category, title: row.title || file.name, doc_no: row.doc_no || null,
      revision: row.revision || 'A', file_name: file.name, file_size: file.size, mime_type: file.type || null, status: 'draft',
    }).select().single()) as Row;
    const path = `${row.project_id || 'general'}/${doc.id}/${safeFileName(file.name)}`;
    const up = await supabase.storage.from(FILES_BUCKET).upload(path, file, { upsert: false, contentType: file.type || undefined });
    if (up.error) {
      await supabase.from('documents').delete().eq('id', doc.id);
      throw up.error;
    }
    await must(supabase.from('documents').update({ storage_path: path }).eq('id', doc.id));
    onDone();
  }, t('doc.uploaded'));

  return (
    <Drawer narrow title={t('doc.upload')} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className="btn primary" disabled={!file || busy} onClick={submit}>{t('doc.upload')}</button>
    </>}>
      <div className="stack" style={{ gap: 12 }}>
        <label className="field">{t('f.file')}<input type="file" onChange={(e) => {
          const f = e.target.files?.[0] ?? null; setFile(f);
          if (f && !row.title) setRow({ ...row, title: f.name.replace(/\.[^.]+$/, '') });
        }} /></label>
        {!projectId && <label className="field">{t('f.project')}<RefSelect refDef={REF.project} value={row.project_id} onChange={(v) => setRow({ ...row, project_id: v })} /></label>}
        <label className="field">{t('f.category')}
          <select value={row.category} onChange={(e) => setRow({ ...row, category: e.target.value })}>
            {E.docCategory.map((c) => <option key={c} value={c}>{te('docCategory', c)}</option>)}
          </select>
        </label>
        <label className="field">{t('f.title')}<input value={row.title} onChange={(e) => setRow({ ...row, title: e.target.value })} /></label>
        <label className="field">{t('f.drawing_no')}<input value={row.doc_no} onChange={(e) => setRow({ ...row, doc_no: e.target.value })} /></label>
        <label className="field">{t('f.revision')}<input value={row.revision} onChange={(e) => setRow({ ...row, revision: e.target.value })} /></label>
      </div>
    </Drawer>
  );
}
