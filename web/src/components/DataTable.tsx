import type { ReactNode } from 'react';
import { useI18n } from '../lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, fmtNumber, fmtPercent, lineNet } from '../lib/format';
import type { ColumnDef, Row } from '../lib/types';
import { Progress, StatusBadge } from './ui';

export function useCell() {
  const { lang, te, t } = useI18n();
  return (c: ColumnDef, r: Row): ReactNode => {
    if (c.render) return c.render(r);
    let v = r[c.name];
    if (c.name === 'net_amount' && v === undefined && r.unit_price !== undefined) v = lineNet(r.qty, r.unit_price, r.discount_pct);
    switch (c.type) {
      case 'status': return <StatusBadge value={v} enumKey={c.enumKey} />;
      case 'select': return te(c.enumKey, v);
      case 'bool': case 'checkbox': return v ? '✓' : '';
      case 'progress': return <Progress value={v} />;
      case 'money': return fmtMoney(v, lang, c.currencyColumn ? r[c.currencyColumn] : undefined);
      case 'number': return fmtNumber(v, lang);
      case 'percent': return fmtPercent(v, lang);
      case 'date': return fmtDate(v, lang);
      case 'datetime': return fmtDateTime(v, lang);
      case 'code': return v ? <span className="code">{String(v)}</span> : '';
      case 'tags': return Array.isArray(v) ? v.join(', ') : '';
      default:
        if (typeof v === 'boolean') return v ? t('a.yes') : t('a.no');
        if (Array.isArray(v)) return v.join(', ');
        return v === null || v === undefined ? '' : String(v);
    }
  };
}

const isNum = (c: ColumnDef) => c.align === 'right' || ['number', 'money', 'percent'].includes(c.type ?? '');

export function DataTable({ columns, rows, onRowClick, sort, onSort, totals, actions, empty }: {
  columns: ColumnDef[];
  rows: Row[];
  onRowClick?: (r: Row) => void;
  sort?: { column: string; asc: boolean };
  onSort?: (s: { column: string; asc: boolean }) => void;
  totals?: string[];
  actions?: (r: Row) => ReactNode;
  empty?: ReactNode;
}) {
  const { t, lang } = useI18n();
  const cell = useCell();
  if (!rows.length) return <div className="empty">{empty ?? t('m.noData')}</div>;
  const sum = (name: string) => rows.reduce((a, r) => {
    const v = r[name] ?? (name === 'net_amount' && r.unit_price !== undefined ? lineNet(r.qty, r.unit_price, r.discount_pct) : 0);
    return a + (Number(v) || 0);
  }, 0);
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.name} className={`${isNum(c) ? 'num' : ''} ${onSort ? 'sortable' : ''}`} style={{ width: c.width }}
                onClick={() => onSort?.({ column: c.name, asc: sort?.column === c.name ? !sort.asc : true })}>
                {t(c.label)}{sort?.column === c.name ? (sort.asc ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
            {actions && <th />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r.id ?? r.po_line_id ?? i)} className={onRowClick ? 'clickable' : ''} onClick={() => onRowClick?.(r)}>
              {columns.map((c) => <td key={c.name} className={isNum(c) ? 'num' : ''}>{cell(c, r)}</td>)}
              {actions && <td className="nowrap right" onClick={(e) => e.stopPropagation()}>{actions(r)}</td>}
            </tr>
          ))}
        </tbody>
        {totals && totals.length > 0 && (
          <tfoot>
            <tr>
              {columns.map((c, i) => (
                <td key={c.name} className={isNum(c) ? 'num' : ''}>
                  {i === 0 ? t('a.total') : totals.includes(c.name) ? fmtNumber(sum(c.name), lang, 2) : ''}
                </td>
              ))}
              {actions && <td />}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}
