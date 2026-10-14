import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import type { ActiveFilters } from '../lib/query';
import { REF } from '../lib/resources';
import { RefSelect } from './Form';

export function StatusPicker({ options, value, onChange, enumKey = 'status' }: {
  options: readonly string[]; value: string[]; onChange: (v: string[]) => void; enumKey?: string;
}) {
  const { t, te } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const label = value.length === 0 ? t('a.all') : value.length <= 2 ? value.map((v) => te(enumKey, v)).join(', ') : `${value.length} ${t('a.selected')}`;
  return (
    <div className="ref" ref={box}>
      <button type="button" className="btn" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setOpen(!open)}>
        <span>{label}</span><span>▾</span>
      </button>
      {open && (
        <div className="menu" style={{ minWidth: 220 }}>
          {options.map((o) => (
            <div key={o} onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])}>
              <input type="checkbox" readOnly checked={value.includes(o)} style={{ verticalAlign: 'middle', marginRight: 8 }} />
              {te(enumKey, o)}
            </div>
          ))}
          {value.length > 0 && <div className="muted" onClick={() => onChange([])}>✕ {t('a.clear')}</div>}
        </div>
      )}
    </div>
  );
}

export function FilterBar({ value, onChange, project, statuses, statusEnumKey, date, search = true, children }: {
  value: ActiveFilters;
  onChange: (f: ActiveFilters) => void;
  project?: boolean;
  statuses?: readonly string[];
  statusEnumKey?: string;
  date?: boolean;
  search?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value.search ?? '');
  useEffect(() => {
    const h = setTimeout(() => { if ((value.search ?? '') !== text) onChange({ ...value, search: text || undefined }); }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  return (
    <div className="filters">
      {search && (
        <label className="field search">{t('a.search')}
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="…" />
        </label>
      )}
      {project && (
        <label className="field" style={{ minWidth: 220 }}>{t('f.project')}
          <RefSelect refDef={REF.project} value={value.projectId ?? null} onChange={(v) => onChange({ ...value, projectId: (v as string) || undefined })} />
        </label>
      )}
      {statuses && statuses.length > 0 && (
        <label className="field" style={{ minWidth: 200 }}>{t('f.status')}
          <StatusPicker options={statuses} value={value.statuses ?? []} enumKey={statusEnumKey}
            onChange={(s) => onChange({ ...value, statuses: s.length ? s : undefined })} />
        </label>
      )}
      {date && (
        <>
          <label className="field">{t('a.dateFrom')}
            <input type="date" value={value.dateFrom ?? ''} onChange={(e) => onChange({ ...value, dateFrom: e.target.value || undefined })} />
          </label>
          <label className="field">{t('a.dateTo')}
            <input type="date" value={value.dateTo ?? ''} onChange={(e) => onChange({ ...value, dateTo: e.target.value || undefined })} />
          </label>
        </>
      )}
      {children}
      {(value.projectId || value.statuses?.length || value.dateFrom || value.dateTo || value.search) && (
        <button className="btn ghost" onClick={() => { setText(''); onChange({}); }}>✕ {t('a.clearFilters')}</button>
      )}
    </div>
  );
}
