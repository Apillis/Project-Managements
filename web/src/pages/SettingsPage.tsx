import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { E, REF, RESOURCES } from '../lib/resources';
import { fmtDateTime } from '../lib/format';
import { buildTree, type Activity, type TreeNode } from '../lib/idef0';
import type { FieldDef, Row } from '../lib/types';
import { ResourceTable } from '../components/Resource';
import { FormGrid } from '../components/Form';
import { Empty, PageHead, Spinner, Tabs, useAction } from '../components/ui';

type STab = 'general' | 'users' | 'permissions' | 'approvals' | 'numbering' | 'currencies' | 'taxes' | 'labor' | 'templates' | 'compliance' | 'warehouses' | 'uoms' | 'costing' | 'importMap';

export function SettingsPage() {
  const { t } = useI18n();
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get('tab') as STab) || 'general';
  const tabs: { key: STab; label: string; hidden?: boolean }[] = [
    { key: 'general', label: t('set.general') },
    { key: 'users', label: t('set.users'), hidden: !can('users', 'read') },
    { key: 'permissions', label: t('set.permissions') },
    { key: 'approvals', label: t('r.approval_rules') },
    { key: 'numbering', label: t('r.doc_sequences') },
    { key: 'currencies', label: t('set.currencies') },
    { key: 'taxes', label: t('r.tax_codes') },
    { key: 'labor', label: t('r.labor_rates'), hidden: !can('finance', 'read') },
    { key: 'templates', label: t('set.templates') },
    { key: 'compliance', label: t('r.compliance_templates') },
    { key: 'warehouses', label: t('r.warehouses') },
    { key: 'uoms', label: t('r.uoms') },
    { key: 'costing', label: t('set.costing') },
    { key: 'importMap', label: t('r.import_mappings') },
  ];
  return (
    <>
      <PageHead title={t('nav.settings')} sub={t('set.sub')} />
      <Tabs tabs={tabs} value={tab} onChange={(k) => setSp({ tab: k }, { replace: true })} />
      {tab === 'general' && <GeneralSettings />}
      {tab === 'users' && <UsersAdmin />}
      {tab === 'permissions' && <PermissionMatrix />}
      {tab === 'approvals' && <><p className="small muted">{t('set.approvalHelp')}</p><ResourceTable def={RESOURCES.approval_rules} /></>}
      {tab === 'numbering' && <ResourceTable def={RESOURCES.doc_sequences} />}
      {tab === 'currencies' && <div className="stack"><ResourceTable def={RESOURCES.currencies} /><ResourceTable def={RESOURCES.exchange_rates} /></div>}
      {tab === 'taxes' && <ResourceTable def={RESOURCES.tax_codes} />}
      {tab === 'labor' && <ResourceTable def={RESOURCES.labor_rates} />}
      {tab === 'templates' && <TemplateEditor />}
      {tab === 'compliance' && <ResourceTable def={RESOURCES.compliance_templates} />}
      {tab === 'uoms' && <div className="stack"><ResourceTable def={RESOURCES.uoms} /><ResourceTable def={RESOURCES.uom_conversions} /></div>}
      {tab === 'costing' && <div className="stack"><p className="small muted">{t('set.costingHelp')}</p><ResourceTable def={RESOURCES.cost_rules} /><ResourceTable def={RESOURCES.labor_step_templates} /></div>}
      {tab === 'importMap' && <><p className="small muted">{t('set.importMapHelp')}</p><ResourceTable def={RESOURCES.import_mappings} /></>}
      {tab === 'warehouses' && <div className="stack"><ResourceTable def={RESOURCES.warehouses} /><ResourceTable def={RESOURCES.locations} /></div>}
    </>
  );
}

function GeneralSettings() {
  const { t } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [edit, setEdit] = useState<Record<string, unknown>>({});
  const [currencies, setCurrencies] = useState<string[]>([]);
  const canWrite = can('settings', 'write');

  const load = useCallback(async () => {
    setRows((await must(supabase.from('app_settings').select('*').order('key'))) as Row[]);
    setEdit({});
    const c = (await must(supabase.from('currencies').select('code').eq('is_active', true).order('code'))) as Row[];
    setCurrencies(c.map((x) => x.code));
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!rows) return <Spinner />;

  const val = (r: Row) => (r.key in edit ? edit[r.key] : r.value);
  const input = (r: Row) => {
    const v = val(r);
    const set = (x: unknown) => setEdit({ ...edit, [r.key]: x });
    if (r.key === 'base_currency') return <select value={String(v)} disabled={!canWrite} onChange={(e) => set(e.target.value)}>{currencies.map((c) => <option key={c}>{c}</option>)}</select>;
    if (r.key === 'default_language') return <select value={String(v)} disabled={!canWrite} onChange={(e) => set(e.target.value)}><option value="vi">Tiếng Việt</option><option value="en">English</option></select>;
    if (typeof r.value === 'boolean') return <input type="checkbox" checked={!!v} disabled={!canWrite} onChange={(e) => set(e.target.checked)} />;
    if (typeof r.value === 'number') return <input type="number" value={String(v)} disabled={!canWrite} onChange={(e) => set(Number(e.target.value))} />;
    if (Array.isArray(r.value)) return <input value={(v as string[]).join(', ')} disabled={!canWrite} onChange={(e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
    return <input type={r.is_secret ? 'password' : 'text'} value={String(v ?? '')} disabled={!canWrite} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="card">
      <div className="card-head"><h3>{t('set.general')}</h3><div className="spacer" />
        {canWrite && <button className="btn primary" disabled={busy || !Object.keys(edit).length} onClick={() => run(async () => {
          for (const [key, value] of Object.entries(edit)) await must(supabase.from('app_settings').update({ value }).eq('key', key));
          await load();
        }, t('m.saved'))}>{t('a.save')}</button>}
      </div>
      <div className="table-wrap"><table className="data">
        <thead><tr><th style={{ width: 230 }}>{t('set.key')}</th><th style={{ width: 380 }}>{t('set.value')}</th><th>{t('f.description')}</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.key}><td className="code">{r.key}</td><td>{input(r)}</td><td className="small muted">{t(`setk.${r.key}`) !== `setk.${r.key}` ? t(`setk.${r.key}`) : r.description}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="card-body small muted">{t('set.smtpNote')}</div>
      {canWrite && (
        <div className="card-body row" style={{ borderTop: '1px solid var(--line)' }}>
          <span className="small muted">{t('set.digestHelp')}</span><div className="spacer" />
          <button className="btn" disabled={busy} onClick={() => run(async () => {
            const n = await must(supabase.rpc('run_daily_digest_now'));
            return n;
          }, t('set.digestSent'))}>✉ {t('set.digestNow')}</button>
        </div>
      )}
    </div>
  );
}

function UsersAdmin() {
  const { t, te, lang } = useI18n();
  const { can, refresh, session } = useAuth();
  const { busy, run } = useAction();
  const [users, setUsers] = useState<Row[] | null>(null);
  const [roles, setRoles] = useState<Row[]>([]);
  const [ur, setUr] = useState<Row[]>([]);
  const [q, setQ] = useState('');
  const canWrite = can('users', 'write');

  const load = useCallback(async () => {
    const [u, r, x] = await Promise.all([
      must(supabase.from('profiles').select('*').order('full_name')),
      must(supabase.from('roles').select('*').order('sort')),
      must(supabase.from('user_roles').select('*')),
    ]);
    setUsers(u as Row[]); setRoles(r as Row[]); setUr(x as Row[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!users) return <Spinner />;

  const has = (uid: string, role: string) => ur.some((x) => x.user_id === uid && x.role_code === role);
  const toggle = (uid: string, role: string) => run(async () => {
    if (has(uid, role)) await must(supabase.from('user_roles').delete().eq('user_id', uid).eq('role_code', role));
    else await must(supabase.from('user_roles').insert({ user_id: uid, role_code: role }));
    await load();
    if (uid === session?.user.id) await refresh();
  });
  const list = users.filter((u) => !q || `${u.full_name} ${u.email}`.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="card">
      <div className="card-head"><h3>{t('set.users')}</h3><span className="muted small">{users.length}</span><div className="spacer" />
        <input className="search" placeholder={t('a.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 240 }} /></div>
      <div className="card-body small muted">{t('set.usersHelp')}</div>
      <div className="table-wrap"><table className="data matrix">
        <thead><tr><th>{t('f.user')}</th><th>{t('f.is_active')}</th>{roles.map((r) => <th key={r.code} title={lang === 'vi' ? r.name_vi : r.name_en} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 130 }}>{te('role', r.code)}</th>)}</tr></thead>
        <tbody>{list.map((u) => (
          <tr key={u.id}>
            <td><strong>{u.full_name}</strong><div className="small muted">{u.email} · {fmtDateTime(u.created_at, lang)}</div></td>
            <td><input type="checkbox" checked={u.is_active} disabled={!canWrite || busy || u.id === session?.user.id}
              onChange={() => run(async () => { await must(supabase.from('profiles').update({ is_active: !u.is_active }).eq('id', u.id)); await load(); })} /></td>
            {roles.map((r) => <td key={r.code}><input type="checkbox" checked={has(u.id, r.code)} disabled={!canWrite || busy} onChange={() => toggle(u.id, r.code)} /></td>)}
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

function PermissionMatrix() {
  const { t, te, lang } = useI18n();
  const { can, refresh } = useAuth();
  const { busy, run } = useAction();
  const [roles, setRoles] = useState<Row[]>([]);
  const [res, setRes] = useState<Row[]>([]);
  const [perm, setPerm] = useState<Row[] | null>(null);
  const canWrite = can('settings', 'write');

  const load = useCallback(async () => {
    const [r, s, p] = await Promise.all([
      must(supabase.from('roles').select('*').order('sort')),
      must(supabase.from('resources').select('*').order('sort')),
      must(supabase.from('permissions').select('*')),
    ]);
    setRoles((r as Row[]).filter((x) => x.code !== 'admin')); setRes(s as Row[]); setPerm(p as Row[]);
  }, []);
  useEffect(() => { void load(); }, [load]);
  if (!perm) return <Spinner />;

  const get = (role: string, resource: string) => perm.find((p) => p.role_code === role && p.resource === resource);
  const set = (role: string, resource: string, mode: 'r' | 'w') => run(async () => {
    const cur = get(role, resource);
    let read = !!cur?.can_read, write = !!cur?.can_write;
    if (mode === 'r') { read = !(read || write); if (!read) write = false; }
    else { write = !write; if (write) read = true; }
    if (!read && !write) await must(supabase.from('permissions').delete().eq('role_code', role).eq('resource', resource));
    else await must(supabase.from('permissions').upsert({ role_code: role, resource, can_read: read, can_write: write }, { onConflict: 'role_code,resource' }));
    await load(); await refresh();
  });

  return (
    <div className="card">
      <div className="card-head"><h3>{t('set.permissions')}</h3></div>
      <div className="card-body small muted">{t('set.permHelp')}</div>
      <div className="table-wrap"><table className="data matrix">
        <thead><tr><th>{t('set.resource')}</th>{roles.map((r) => <th key={r.code} style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 130 }}>{te('role', r.code)}</th>)}</tr></thead>
        <tbody>{res.map((s) => (
          <tr key={s.code}>
            <td><strong>{lang === 'vi' ? s.name_vi : s.name_en}</strong><div className="small muted code">{s.code}</div></td>
            {roles.map((r) => {
              const p = get(r.code, s.code);
              return (
                <td key={r.code}>
                  <span className="rw">
                    <button className={`r ${p?.can_read || p?.can_write ? 'on' : ''}`} disabled={!canWrite || busy || r.code === 'management'} onClick={() => set(r.code, s.code, 'r')} title={t('set.read')}>R</button>
                    <button className={`w ${p?.can_write ? 'on' : ''}`} disabled={!canWrite || busy} onClick={() => set(r.code, s.code, 'w')} title={t('set.write')}>W</button>
                  </span>
                </td>
              );
            })}
          </tr>
        ))}</tbody>
      </table></div>
    </div>
  );
}

const NODE_FIELDS: FieldDef[] = [
  { name: 'title_vi', label: 'f.title_vi', type: 'text', required: true, wide: true },
  { name: 'title_en', label: 'f.title_en', type: 'text', required: true, wide: true },
  { name: 'kind', label: 'f.kind', type: 'select', enumKey: 'activityKind', options: E.activityKind },
  { name: 'role_code', label: 'f.role', type: 'ref', ref: REF.role },
  { name: 'duration_days', label: 'f.duration_days', type: 'number', min: 0 },
  { name: 'est_hours', label: 'f.est_hours', type: 'number', min: 0 },
  { name: 'is_milestone', label: 'f.is_milestone', type: 'checkbox' },
];

function TemplateEditor() {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [tpls, setTpls] = useState<Row[]>([]);
  const [tpl, setTpl] = useState<string | null>(null);
  const [nodes, setNodes] = useState<Row[]>([]);
  const [icoms, setIcoms] = useState<Row[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [form, setForm] = useState<Row | null>(null);
  const [ic, setIc] = useState({ type: 'I', en: '', vi: '' });
  const canWrite = can('settings', 'write');

  const load = useCallback(async () => {
    const list = (await must(supabase.from('lifecycle_templates').select('*').order('code'))) as Row[];
    setTpls(list);
    const cur = tpl ?? list.find((x) => x.is_default)?.id ?? list[0]?.id ?? null;
    setTpl(cur);
    if (cur) {
      const ns = (await must(supabase.from('template_nodes').select('*').eq('template_id', cur))) as Row[];
      setNodes(ns);
      setIcoms(ns.length ? (await must(supabase.from('template_icoms').select('*').in('node_id', ns.map((n) => n.id)).order('sort'))) as Row[] : []);
    }
  }, [tpl]);
  useEffect(() => { void load(); }, [load]);

  const current = nodes.find((n) => n.id === sel);
  useEffect(() => { setForm(current ? { ...current } : null); }, [current]);

  // derive node codes like the activity tree
  const asActs: Activity[] = nodes.map((n) => ({ id: n.id, parent_id: n.parent_id, seq: n.seq, title: lang === 'vi' ? n.title_vi : n.title_en, node_code: '' }));
  const tree = buildTree(asActs);
  const codeOf = new Map<string, string>();
  const walk = (list: TreeNode[], parent: string) => list.forEach((n) => {
    const code = parent === '' ? 'A0' : parent === 'A0' ? `A${n.node.seq}` : `${parent}${n.node.seq}`;
    codeOf.set(n.node.id, code); walk(n.children, code);
  });
  walk(tree, '');

  const render = (list: TreeNode[]) => (
    <ul>{list.map((n) => (
      <li key={n.node.id}>
        <div className={`node ${sel === n.node.id ? 'sel' : ''}`} onClick={() => setSel(n.node.id)}>
          <span className="code">{codeOf.get(n.node.id)}</span><span>{n.node.title}</span>
        </div>
        {n.children.length > 0 && render(n.children)}
      </li>
    ))}</ul>
  );

  return (
    <div className="idef0-layout">
      <div className="card">
        <div className="card-head">
          <select value={tpl ?? ''} onChange={(e) => { setTpl(e.target.value); setSel(null); }}>
            {tpls.map((x) => <option key={x.id} value={x.id}>{lang === 'vi' ? x.name_vi : x.name_en}{x.is_default ? ' ★' : ''}</option>)}
          </select>
        </div>
        <div className="card-body tree" style={{ maxHeight: 600, overflow: 'auto' }}>{nodes.length ? render(tree) : <Empty />}</div>
        {canWrite && current && (
          <div className="card-body row" style={{ borderTop: '1px solid var(--line)' }}>
            <button className="btn sm" disabled={busy} onClick={() => run(async () => {
              const used = nodes.filter((n) => n.parent_id === current.id).map((n) => n.seq);
              const seq = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((s) => !used.includes(s));
              if (!seq) throw new Error(t('idef.max9'));
              await must(supabase.from('template_nodes').insert({ template_id: tpl, parent_id: current.id, seq, title_en: 'New activity', title_vi: 'Công việc mới', kind: 'task', duration_days: 1 }));
              await load();
            })}>+ {t('idef.addChild')}</button>
            {current.parent_id && <button className="btn sm danger" disabled={busy} onClick={() => {
              if (!confirm(t('m.confirmDelete'))) return;
              void run(async () => { await must(supabase.from('template_nodes').delete().eq('id', current.id)); setSel(null); await load(); });
            }}>{t('a.delete')}</button>}
          </div>
        )}
      </div>
      <div className="stack">
        <p className="small muted">{t('set.templateHelp')}</p>
        {current && form ? (
          <div className="grid cols-2">
            <div className="card">
              <div className="card-head"><h3><span className="code">{codeOf.get(current.id)}</span></h3><div className="spacer" />
                {canWrite && <button className="btn primary sm" disabled={busy} onClick={() => run(async () => {
                  const p: Row = {}; for (const f of NODE_FIELDS) p[f.name] = form[f.name] === '' ? null : form[f.name];
                  await must(supabase.from('template_nodes').update(p).eq('id', current.id)); await load();
                }, t('m.saved'))}>{t('a.save')}</button>}
              </div>
              <div className="card-body"><FormGrid fields={NODE_FIELDS} row={form} setRow={setForm} disabled={!canWrite} /></div>
            </div>
            <div className="card">
              <div className="card-head"><h3>{t('idef.icom')}</h3></div>
              <div className="card-body icom-list">
                {icoms.filter((i) => i.node_id === current.id).map((i) => (
                  <div key={i.id} className="ic"><span className={`icom-tag ${i.icom_type}`}>{i.icom_type}</span>
                    <span>{lang === 'vi' ? i.label_vi : i.label_en}<span className="small muted"> / {lang === 'vi' ? i.label_en : i.label_vi}</span></span>
                    {canWrite && <button className="btn ghost sm" onClick={() => run(async () => { await must(supabase.from('template_icoms').delete().eq('id', i.id)); await load(); })}>✕</button>}
                  </div>
                ))}
                {canWrite && (
                  <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                    <select value={ic.type} onChange={(e) => setIc({ ...ic, type: e.target.value })}>
                      {(['I', 'C', 'O', 'M'] as const).map((k) => <option key={k} value={k}>{k} · {t(`icom.${k}`)}</option>)}
                    </select>
                    <input placeholder="Tiếng Việt" value={ic.vi} onChange={(e) => setIc({ ...ic, vi: e.target.value })} />
                    <input placeholder="English" value={ic.en} onChange={(e) => setIc({ ...ic, en: e.target.value })} />
                    <button className="btn primary sm" disabled={busy || !ic.vi || !ic.en} onClick={() => run(async () => {
                      await must(supabase.from('template_icoms').insert({ node_id: current.id, icom_type: ic.type, label_en: ic.en, label_vi: ic.vi, sort: 99 }));
                      setIc({ ...ic, en: '', vi: '' }); await load();
                    })}>+ {t('idef.addArrow')}</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : <div className="card"><Empty>{t('set.pickNode')}</Empty></div>}
      </div>
    </div>
  );
}

export function AuditPage() {
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [table, setTable] = useState('');
  useEffect(() => {
    let q = supabase.from('audit_log').select('*').order('changed_at', { ascending: false }).limit(300);
    if (table) q = q.eq('table_name', table);
    q.then(async ({ data }) => {
      const list = (data as Row[]) ?? [];
      setRows(list);
      const ids = Array.from(new Set(list.map((r) => r.changed_by).filter(Boolean)));
      if (ids.length) {
        const { data: ps } = await supabase.from('profiles').select('id, full_name').in('id', ids);
        setNames(Object.fromEntries(((ps as Row[]) ?? []).map((p) => [p.id, p.full_name])));
      }
    });
  }, [table]);
  return (
    <>
      <PageHead title={t('nav.audit')} sub={t('au.sub')}>
        <input placeholder={t('au.table')} value={table} onChange={(e) => setTable(e.target.value.trim())} style={{ width: 220 }} />
      </PageHead>
      <div className="card">
        {!rows ? <Spinner /> : rows.length === 0 ? <Empty /> : (
          <div className="table-wrap"><table className="data">
            <thead><tr><th>{t('au.when')}</th><th>{t('au.who')}</th><th>{t('au.table')}</th><th>{t('au.action')}</th><th>{t('au.changes')}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td className="nowrap">{fmtDateTime(r.changed_at, lang)}</td><td>{names[r.changed_by] ?? '—'}</td>
                <td className="code">{r.table_name}</td><td>{r.action}</td>
                <td className="small" style={{ maxWidth: 640, wordBreak: 'break-word' }}>
                  {r.action === 'UPDATE' ? Object.entries((r.new_data as Row) ?? {}).map(([k, v]) => `${k}: ${JSON.stringify((r.old_data as Row)?.[k])} → ${JSON.stringify(v)}`).join(' · ')
                    : JSON.stringify(r.new_data ?? r.old_data).slice(0, 300)}
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function ProfilePage() {
  const { t, lang, setLang, te } = useI18n();
  const { profile, roles, refresh } = useAuth();
  const { busy, run } = useAction();
  const [name, setName] = useState(profile?.full_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [pw, setPw] = useState('');
  if (!profile) return <Spinner />;
  const recovery = new URLSearchParams(window.location.search).has('recovery');
  return (
    <>
      <PageHead title={t('pf.title')} sub={profile.email} />
      {recovery && <div className="card" style={{ marginBottom: 12, borderColor: 'var(--warn)' }}><div className="card-body">🔑 {t('pf.recoveryHint')}</div></div>}
      <div className="grid cols-2">
        <div className="card"><div className="card-body stack">
          <label className="field">{t('f.full_name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">{t('f.phone')}<input value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <label className="field">{t('pf.language')}
            <select value={lang} onChange={(e) => setLang(e.target.value as 'vi' | 'en')}><option value="vi">Tiếng Việt</option><option value="en">English</option></select>
          </label>
          <div><button className="btn primary" disabled={busy} onClick={() => run(async () => {
            await must(supabase.from('profiles').update({ full_name: name, phone, locale: lang }).eq('id', profile.id)); await refresh();
          }, t('m.saved'))}>{t('a.save')}</button></div>
          <div className="small muted">{t('pf.roles')}: {roles.map((r) => te('role', r)).join(', ') || '—'}</div>
        </div></div>
        <div className="card"><div className="card-body stack">
          <label className="field">{t('pf.newPassword')}<input type="password" value={pw} minLength={8} onChange={(e) => setPw(e.target.value)} /></label>
          <div><button className="btn" disabled={busy || pw.length < 8} onClick={() => run(async () => {
            const { error } = await supabase.auth.updateUser({ password: pw }); if (error) throw error; setPw('');
          }, t('pf.passwordChanged'))}>{t('pf.changePassword')}</button></div>
        </div></div>
      </div>
    </>
  );
}
