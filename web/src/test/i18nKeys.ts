// Collects every i18n key used by the code so the test can check that both
// languages define it. Static keys come from source scanning; dynamic keys
// (enums, statuses, roles, modules …) are generated from the definitions.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { E, RESOURCES } from '../lib/resources';
import { EXPORTS, EXPORT_MODULES } from '../lib/exports';
import { IMPORTS } from '../lib/importer';
import { AGING_BUCKETS, CLOSE_CHECKS } from '../lib/finance';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'test' ? [] : files(p);
    return /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && f !== 'dict.ts' ? [p] : [];
  });
}

const KEY_RE = /\b(?:t|translate\(lang,\s*)\(\s*'([a-zA-Z][\w.]*)'/g;
const PROP_RE = /\b(?:label|title|titleOne|purpose|help|labelKey)\s*:\s*'([a-z]+\.[\w.]+)'/g;
const ARR_RE = /\[\s*'[\w]+'\s*,\s*'([a-z]+\.[\w.]+)'/g;   // dashboard cards ['key','db.x',...]
const COL_RE = /\bc\(\s*'[\w]+'\s*,\s*'([a-z]+\.[\w.]+)'/g;   // export columns c('key','f.x')

export function collectKeys(srcDir: string): Set<string> {
  const keys = new Set<string>();
  for (const f of files(srcDir)) {
    const s = readFileSync(f, 'utf8');
    for (const re of [KEY_RE, PROP_RE, ARR_RE, COL_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) keys.add(m[1]);
    }
  }
  // dynamic keys
  const statusEnums = ['quotationStatus', 'soStatus', 'projectStatus', 'activityStatus', 'bomStatus', 'ecoStatus', 'docStatus',
    'prStatus', 'poStatus', 'inspectionResult', 'ncrStatus', 'complianceStatus', 'serviceStatus', 'timesheetStatus',
    'mrStatus', 'shipmentStatus', 'milestoneStatus', 'invoiceStatus'] as const;
  for (const e of statusEnums) for (const v of E[e]) keys.add(`s.${v}`);
  for (const v of ['pending', 'waiting', 'cancelled', 'approved', 'rejected', 'active', 'on_hold']) keys.add(`s.${v}`);
  const enumMap: Record<string, readonly string[]> = {
    market: [...E.market, 'GLOBAL'], itemType: E.itemType, activityKind: E.activityKind, discipline: E.discipline, makeOrBuy: E.makeOrBuy,
    ecoReason: E.ecoReason, docCategory: E.docCategory, priority: E.priority, moveType: E.moveType, inspectionType: E.inspectionType,
    severity: E.severity, disposition: E.disposition, complianceCategory: E.complianceCategory, docType: E.docType,
    shipmentDirection: E.shipmentDirection, paymentDirection: E.paymentDirection, paymentMethod: E.paymentMethod,
    role: ['admin', 'management', 'pmo', 'sales', 'engineering_lead', 'engineering', 'production', 'procurement', 'warehouse',
      'logistics', 'qa', 'accounting', 'service'],
  };
  for (const [k, vals] of Object.entries(enumMap)) for (const v of vals) keys.add(`e.${k}.${v}`);
  for (const m of [...EXPORT_MODULES, 'settings']) keys.add(`mod.${m}`);
  for (const r of Object.values(RESOURCES)) keys.add(`mod.${r.module}`);
  for (const x of EXPORTS) { if (x.dateColumn) keys.add(`f.${x.dateColumn}`); }
  for (const k of Object.keys(IMPORTS)) keys.add(`im.${k}`);
  for (const k of ['I', 'C', 'O', 'M']) { keys.add(`icom.${k}`); keys.add(`icomHelp.${k}`); }
  for (const k of ['list', 'analysis']) keys.add(`xc.${k}`);
  for (const k of ['company_name', 'base_currency', 'allowed_email_domains', 'default_tax_code', 'default_language', 'receipt_tolerance_pct',
    'approval_allow_self', 'working_hours_per_day', 'notify_email_enabled', 'notify_gchat_enabled', 'gchat_webhook_url', 'app_base_url',
    'rfq_email_enabled', 'default_labor_rate', 'issue_requires_request', 'default_payment_days', 'project_close_strict', 'digest_enabled', 'digest_hour', 'timezone',
    'approval_reminder_days']) keys.add(`setk.${k}`);
  // finance tabs / aging buckets and the project closure checklist (rendered from data)
  for (const k of ['pnl', 'cashflow', 'receivables']) keys.add(`fin.${k}`);
  for (const b of AGING_BUCKETS) keys.add(`fin.aging.${b}`);
  for (const k of CLOSE_CHECKS) keys.add(`close.${k}`);
  // not real keys
  for (const k of [...keys]) if (/^(a|f)\.$/.test(k) || k.endsWith('.')) keys.delete(k);
  return keys;
}
