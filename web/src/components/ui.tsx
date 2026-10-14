import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { errorKey } from '../lib/api';

// ------------------------------------------------------------------ status badge
const COLORS: Record<string, string> = {
  draft: 'gray', planning: 'gray', not_started: 'gray', pending: 'amber', open: 'red',
  pending_approval: 'amber', submitted: 'amber', in_review: 'amber', investigating: 'amber', action: 'amber',
  verification: 'purple', waiting_parts: 'amber', on_hold: 'amber', blocked: 'red', conditional: 'amber',
  approved: 'green', pass: 'green', done: 'green', received: 'green', won: 'green', released: 'green', resolved: 'green',
  delivered: 'green', ordered: 'blue', sent: 'blue', active: 'blue', in_progress: 'blue',
  partially_ordered: 'purple', partially_received: 'purple',
  rejected: 'red', fail: 'red', lost: 'red', cancelled: 'red',
  closed: 'dark', superseded: 'gray', implemented: 'dark', obsolete: 'gray', not_applicable: 'gray',
  receipt: 'green', issue: 'blue', return: 'purple', transfer: 'gray', adjust: 'amber',
};

export function StatusBadge({ value, enumKey }: { value: unknown; enumKey?: string }) {
  const { te } = useI18n();
  if (value === null || value === undefined || value === '') return null;
  const v = String(value);
  return <span className={`badge ${COLORS[v] ?? 'gray'}`}>{te(enumKey ?? 'status', v)}</span>;
}

export function Progress({ value }: { value: unknown }) {
  const n = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="row nowrap" style={{ gap: 6 }}>
      <div className={`progress ${n >= 100 ? 'done' : ''}`} style={{ flex: 1 }}><div style={{ width: `${n}%` }} /></div>
      <span className="small muted">{Math.round(n)}%</span>
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      <div className="spacer" />
      {children}
    </div>
  );
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <div className="empty">{children ?? t('m.noData')}</div>;
}

export function Spinner() {
  const { t } = useI18n();
  return <div className="empty">{t('m.loading')}</div>;
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { key: T; label: ReactNode; hidden?: boolean }[]; value: T; onChange: (k: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.filter((t) => !t.hidden).map((t) => (
        <button key={t.key} role="tab" aria-selected={value === t.key} className={value === t.key ? 'active' : ''} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ title, onClose, children, footer, narrow }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`drawer ${narrow ? 'narrow' : ''}`} role="dialog" aria-modal="true">
        <header><h2>{title}</h2><div style={{ flex: 1 }} /><button className="btn ghost icon" onClick={onClose} aria-label="close">✕</button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Dialog({ title, children, footer, onClose }: { title: ReactNode; children: ReactNode; footer: ReactNode; onClose: () => void }) {
  return (
    <div className="backdrop modal-center" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="body"><h2>{title}</h2>{children}</div>
        <footer>{footer}</footer>
      </div>
    </div>
  );
}

/** Ask for an optional/required comment, then resolve */
export function PromptDialog({ title, label, required, confirmLabel, danger, onConfirm, onClose }: {
  title: string; label: string; required?: boolean; confirmLabel: string; danger?: boolean;
  onConfirm: (text: string) => Promise<void> | void; onClose: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>{t('a.cancel')}</button>
      <button className={`btn ${danger ? 'danger solid' : 'primary'}`} disabled={busy || (required && !text.trim())}
        onClick={async () => { setBusy(true); try { await onConfirm(text); onClose(); } finally { setBusy(false); } }}>{confirmLabel}</button>
    </>}>
      <label className="field">{label}<textarea value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; text: string; kind: 'info' | 'error' | 'ok' }
const ToastCtx = createContext<{ push: (text: string, kind?: Toast['kind']) => void; error: (e: unknown) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'error' ? 9000 : 3500);
  }, []);
  const error = useCallback((e: unknown) => {
    const { key, raw } = errorKey(e);
    push(key ? `${t(key)}\n${raw}` : raw, 'error');
  }, [push, t]);
  return (
    <ToastCtx.Provider value={{ push, error }}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((i) => <div key={i.id} className={`toast ${i.kind}`}>{i.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const c = useContext(ToastCtx);
  if (!c) throw new Error('useToast outside provider');
  return c;
}

/** Run an async action with toast error handling */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okText?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (okText) toast.push(okText, 'ok');
      return r;
    } catch (e) {
      toast.error(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { busy, run };
}
