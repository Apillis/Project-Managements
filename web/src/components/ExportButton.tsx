import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { fetchAll, refLabel } from '../lib/api';
import { findExport, type ExportSpec } from '../lib/exports';
import { describeFilters, type ActiveFilters } from '../lib/query';
import { REF } from '../lib/resources';
import { useAction } from './ui';
import { supabase } from '../lib/supabase';

/** Returns a function that exports a catalogue entry with the given filters. */
export function useExporter() {
  const { t, te, lang } = useI18n();
  const { profile } = useAuth();
  const { busy, run } = useAction();

  const exportSpec = (spec: ExportSpec, filters: ActiveFilters) => run(async () => {
    const target = { projectColumn: spec.projectColumn, statusColumn: spec.statusColumn, dateColumn: spec.dateColumn };
    const rows = await fetchAll(spec.source, filters, target, spec.orderBy);
    const { data: company } = await supabase.from('app_settings').select('value').eq('key', 'company_name').maybeSingle();
    const projectLabel = filters.projectId ? await refLabel(REF.project, filters.projectId) : undefined;
    const filterText = describeFilters(filters, {
      project: projectLabel, status: (s) => te(spec.statusEnumKey ?? 'status', s), from: t('a.dateFrom'), to: t('a.dateTo'),
      search: t('a.search'), projectLabel: t('f.project'), statusLabel: t('f.status'), dateLabel: t('a.date'),
    });
    const { buildWorkbook, downloadWorkbook, exportFileName } = await import('../lib/excel');
    const wb = buildWorkbook(
      spec.columns.map((c) => ({
        key: c.key, header: t(c.label), type: c.type, width: c.width,
        format: c.type === 'status' ? (v) => te('status', v) : c.type === 'enum' ? (v) => te(c.enumKey, v) : undefined,
      })),
      rows,
      {
        company: String(company?.value ?? 'Apillis'), title: t(spec.title), filters: filterText,
        exportedBy: String(profile?.full_name || profile?.email || ''), exportedAt: new Date(),
        labels: { filters: t('x.filters'), exportedBy: t('x.exportedBy'), total: t('a.total'), yes: t('a.yes'), no: t('a.no'), rows: t('x.rows') },
      },
    );
    await downloadWorkbook(wb, exportFileName(spec.key));
    return rows.length;
  }, undefined);

  return { busy, exportSpec, lang };
}

export function ExportButton({ exportKey, filters, label }: { exportKey?: string; filters: ActiveFilters; label?: string }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, exportSpec } = useExporter();
  const spec = exportKey ? findExport(exportKey) : undefined;
  if (!spec || !can(spec.resource, 'read')) return null;
  return (
    <button className="btn" disabled={busy} onClick={() => exportSpec(spec, filters)} title={t(spec.purpose)}>
      ⬇ {busy ? t('m.exporting') : label ?? t('a.exportExcel')}
    </button>
  );
}
