import type { Lang } from './dict';

const locale = (lang: Lang) => (lang === 'vi' ? 'vi-VN' : 'en-GB');

export function fmtNumber(v: unknown, lang: Lang, maxDecimals = 4): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return new Intl.NumberFormat(locale(lang), { maximumFractionDigits: maxDecimals }).format(n);
}

const ZERO_DEC = new Set(['VND', 'JPY', 'KRW']);

export function fmtMoney(v: unknown, lang: Lang, currency?: string | null): string {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const d = currency && ZERO_DEC.has(currency) ? 0 : 2;
  const s = new Intl.NumberFormat(locale(lang), { minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
  return currency ? `${s} ${currency}` : s;
}

export function fmtPercent(v: unknown, lang: Lang): string {
  if (v === null || v === undefined || v === '') return '';
  return `${fmtNumber(v, lang, 1)} %`;
}

export function fmtDate(v: unknown, lang: Lang): string {
  if (!v) return '';
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function fmtDateTime(v: unknown, lang: Lang): string {
  if (!v) return '';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return new Intl.DateTimeFormat(locale(lang), { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d);
}

export function isoDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

/** Monday of the week containing iso date */
export function weekStart(iso: string): string {
  const d = new Date(iso + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  return isoDate(d);
}

export function lineNet(qty: unknown, price: unknown, disc: unknown): number {
  const q = Number(qty) || 0, p = Number(price) || 0, ds = Number(disc) || 0;
  return Math.round(q * p * (1 - ds / 100) * 10000) / 10000;
}
