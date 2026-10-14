import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { labelOf, refLabel, searchRef } from '../lib/api';
import type { FieldDef, RefDef, Row } from '../lib/types';

export function RefSelect({ refDef, value, onChange, row, disabled, placeholder }: {
  refDef: RefDef; value: unknown; onChange: (v: unknown, picked: Row | null) => void; row?: Row; disabled?: boolean; placeholder?: string;
}) {
  const { t } = useI18n();
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Row[]>([]);
  const [hl, setHl] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const valueCol = refDef.valueColumn ?? 'id';

  useEffect(() => {
    let alive = true;
    if (value === null || value === undefined || value === '') { setLabel(''); return; }
    refLabel(refDef, value).then((l) => { if (alive) setLabel(l); }).catch(() => setLabel(String(value)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, refDef.table]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const h = setTimeout(() => {
      searchRef(refDef, text, row ?? {}).then((r) => { if (alive) { setOpts(r); setHl(0); } }).catch(() => setOpts([]));
    }, 180);
    return () => { alive = false; clearTimeout(h); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (o: Row | null) => {
    onChange(o ? o[valueCol] : null, o);
    setLabel(o ? labelOf(refDef, o) : '');
    setText('');
    setOpen(false);
  };

  return (
    <div className="ref" ref={box}>
      <input
        value={open ? text : label}
        placeholder={open ? label || placeholder || t('a.search') : placeholder}
        disabled={disabled}
        onFocus={() => { setOpen(true); setText(''); }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHl((h) => Math.min(h + 1, opts.length - 1)); e.preventDefault(); }
          else if (e.key === 'ArrowUp') { setHl((h) => Math.max(h - 1, 0)); e.preventDefault(); }
          else if (e.key === 'Enter' && open && opts[hl]) { pick(opts[hl]); e.preventDefault(); }
          else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {!disabled && label && !open && <button type="button" className="clear" onClick={() => pick(null)} aria-label="clear">✕</button>}
      {open && !disabled && (
        <div className="menu">
          {opts.length === 0 && <div className="muted">{t('m.noMatch')}</div>}
          {opts.map((o, i) => (
            <div key={String(o[valueCol])} className={i === hl ? 'hl' : ''} onMouseDown={(e) => { e.preventDefault(); pick(o); }}>
              {labelOf(refDef, o)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function FieldInput({ f, row, setRow, disabled, isNew }: {
  f: FieldDef; row: Row; setRow: (r: Row) => void; disabled?: boolean; isNew?: boolean;
}) {
  const { t, te } = useI18n();
  const v = row[f.name];
  const ro = disabled || f.readOnly || (!isNew && f.createOnly);
  const set = (val: unknown) => setRow({ ...row, [f.name]: val });

  switch (f.type) {
    case 'checkbox':
      return <input type="checkbox" checked={!!v} disabled={ro} onChange={(e) => set(e.target.checked)} />;
    case 'textarea':
      return <textarea value={(v as string) ?? ''} readOnly={ro} disabled={ro} onChange={(e) => set(e.target.value)} />;
    case 'select':
      return (
        <select value={(v as string) ?? ''} disabled={ro} onChange={(e) => set(e.target.value || null)}>
          {!f.required && <option value="">—</option>}
          {(f.options ?? []).map((o) => <option key={o} value={o}>{te(f.enumKey, o)}</option>)}
        </select>
      );
    case 'ref':
      return <RefSelect refDef={f.ref!} value={v} row={row} disabled={ro}
        onChange={(val, picked) => {
          let next = { ...row, [f.name]: val };
          if (picked && f.onPick) next = f.onPick(picked, next);
          setRow(next);
        }} />;
    case 'number': case 'money': case 'percent':
      return <input type="number" value={v === null || v === undefined ? '' : String(v)} readOnly={ro} disabled={ro}
        min={f.min} max={f.max} step={f.step ?? (f.type === 'money' ? 0.01 : 'any')}
        onChange={(e) => set(e.target.value === '' ? null : e.target.value)} />;
    case 'date':
      return <input type="date" value={(v as string)?.slice(0, 10) ?? ''} readOnly={ro} disabled={ro} onChange={(e) => set(e.target.value || null)} />;
    case 'datetime':
      return <input type="datetime-local" value={(v as string)?.slice(0, 16) ?? ''} readOnly={ro} disabled={ro} onChange={(e) => set(e.target.value || null)} />;
    case 'tags':
      return <input value={Array.isArray(v) ? (v as string[]).join(', ') : ''} readOnly={ro} disabled={ro} placeholder="CE, UL, NFPA 79"
        onChange={(e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
    case 'json':
      return <textarea value={typeof v === 'string' ? v : JSON.stringify(v ?? null, null, 2)} readOnly={ro} disabled={ro}
        onChange={(e) => { try { set(JSON.parse(e.target.value)); } catch { set(e.target.value); } }} />;
    default:
      return <input type={f.type === 'email' ? 'email' : 'text'} value={(v as string) ?? ''} readOnly={ro} disabled={ro}
        onChange={(e) => set(e.target.value)} placeholder={f.type === 'email' ? 'name@company.com' : undefined}
        aria-label={t(f.label)} />;
  }
}

export function FormGrid({ fields, row, setRow, errors = {}, disabled, isNew }: {
  fields: FieldDef[]; row: Row; setRow: (r: Row) => void; errors?: Record<string, string>; disabled?: boolean; isNew?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div className="form-grid">
      {fields.filter((f) => !f.hidden).map((f) => (
        <label key={f.name} className={`field ${f.type === 'checkbox' ? 'check' : ''} ${f.wide || f.type === 'textarea' ? 'wide' : ''}`}>
          {f.type === 'checkbox' && <FieldInput f={f} row={row} setRow={setRow} disabled={disabled} isNew={isNew} />}
          <span>{t(f.label)}{f.required && <span className="err"> *</span>}</span>
          {f.type !== 'checkbox' && <FieldInput f={f} row={row} setRow={setRow} disabled={disabled} isNew={isNew} />}
          {errors[f.name] && <span className="err">{t(errors[f.name])}</span>}
          {f.help && !errors[f.name] && <span className="help">{t(f.help)}</span>}
        </label>
      ))}
    </div>
  );
}
