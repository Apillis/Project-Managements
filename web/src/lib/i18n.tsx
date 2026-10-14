import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { DICT, type Lang } from './dict';

export type { Lang };

function readLang(): Lang {
  try {
    const v = localStorage.getItem('pm.lang');
    if (v === 'en' || v === 'vi') return v;
  } catch { /* storage blocked */ }
  return 'vi';
}

export function translate(lang: Lang, key: string, vars?: Record<string, string | number>): string {
  let s = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

export function enumLabel(lang: Lang, enumKey: string | undefined, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  const v = String(value);
  const key = !enumKey || enumKey === 'status' ? `s.${v}` : `e.${enumKey}.${v}`;
  const out = DICT[lang][key] ?? DICT.en[key];
  return out ?? v;
}

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  te: (enumKey: string | undefined, value: unknown) => string;
}

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try { localStorage.setItem('pm.lang', l); } catch { /* ignore */ }
    document.documentElement.lang = l;
  }, []);
  const value = useMemo<I18n>(() => ({
    lang,
    setLang,
    t: (k, vars) => translate(lang, k, vars),
    te: (e, v) => enumLabel(lang, e, v),
  }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside provider');
  return c;
}
