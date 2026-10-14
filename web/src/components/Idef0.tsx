import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { must } from '../lib/api';
import { ancestors, buildTree, layoutIdef0, pathOf, wrapText, type Activity, type Icom, type TreeNode } from '../lib/idef0';
import { E, REF } from '../lib/resources';
import type { FieldDef, Row } from '../lib/types';
import { FormGrid } from './Form';
import { Empty, Progress, Spinner, StatusBadge, useAction } from './ui';

const COLORS: Record<string, string> = { I: 'var(--icom-i)', C: 'var(--icom-c)', O: 'var(--icom-o)', M: 'var(--icom-m)' };
const STATUS_FILL: Record<string, string> = { done: '#e8f6ee', in_progress: '#eaf2fc', blocked: '#fdecea', cancelled: '#f2f2f2' };

export const ACTIVITY_FIELDS: FieldDef[] = [
  { name: 'title', label: 'f.title', type: 'text', required: true, wide: true },
  { name: 'kind', label: 'f.kind', type: 'select', enumKey: 'activityKind', options: E.activityKind, required: true },
  { name: 'status', label: 'f.status', type: 'select', enumKey: 'status', options: E.activityStatus, required: true },
  { name: 'role_code', label: 'f.role', type: 'ref', ref: REF.role },
  { name: 'assignee_id', label: 'f.assignee', type: 'ref', ref: REF.user },
  { name: 'planned_start', label: 'f.planned_start', type: 'date' },
  { name: 'planned_end', label: 'f.planned_end', type: 'date' },
  { name: 'actual_start', label: 'f.actual_start', type: 'date' },
  { name: 'actual_end', label: 'f.actual_end', type: 'date' },
  { name: 'est_hours', label: 'f.est_hours', type: 'number', min: 0 },
  { name: 'progress_pct', label: 'f.progress', type: 'percent', min: 0, max: 100 },
  { name: 'is_milestone', label: 'f.is_milestone', type: 'checkbox' },
  { name: 'description', label: 'f.description', type: 'textarea', wide: true },
];

export function Idef0Diagram({ items, icoms, selected, onSelect }: {
  items: Activity[]; icoms: Icom[]; selected?: string; onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  const L = useMemo(() => layoutIdef0(items, icoms), [items, icoms]);
  if (!items.length) return <Empty>{t('idef.noChildren')}</Empty>;
  return (
    <div className="diagram">
      <svg width={L.width} height={L.height} viewBox={`0 0 ${L.width} ${L.height}`} role="img" aria-label="IDEF0 diagram">
        <defs>
          {Object.entries(COLORS).map(([k, c]) => (
            <marker key={k} id={`ah-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={c} />
            </marker>
          ))}
        </defs>
        {L.arrows.map((a) => (
          <g key={a.id + a.type}>
            <path d={pathOf(a.points)} fill="none" stroke={COLORS[a.type]} strokeWidth={a.internal ? 1.8 : 1.4}
              strokeDasharray={a.internal ? undefined : undefined} markerEnd={`url(#ah-${a.type})`} />
            <text x={a.labelAt[0]} y={a.labelAt[1]} fontSize="11" fill={COLORS[a.type]} textAnchor={a.labelAnchor}>{a.label}</text>
          </g>
        ))}
        {L.boxes.map((b) => (
          <g key={b.id} onClick={() => onSelect(b.id)} style={{ cursor: 'pointer' }}>
            <rect className="box" x={b.x} y={b.y} width={b.w} height={b.h} rx="3" fill={STATUS_FILL[b.status ?? ''] ?? '#fff'}
              stroke={selected === b.id ? '#0f4c81' : '#344054'} strokeWidth={selected === b.id ? 2.5 : 1.4} />
            {wrapText(b.title).map((line, i, arr) => (
              <text key={i} x={b.x + b.w / 2} y={b.y + b.h / 2 - (arr.length - 1) * 8 + i * 16} fontSize="13" fontWeight="600"
                textAnchor="middle" dominantBaseline="middle" fill="#1c2430">{line}</text>
            ))}
            <text x={b.x + b.w - 6} y={b.y + b.h - 6} fontSize="11" textAnchor="end" fill="#0f4c81" fontWeight="700">{b.code}</text>
            <rect x={b.x + 6} y={b.y + b.h - 9} width={(b.w * 0.45) * (Math.min(100, b.progress ?? 0) / 100)} height="3" fill="#1e8449" />
          </g>
        ))}
      </svg>
      <div className="legend" style={{ padding: '8px 12px' }}>
        {(['I', 'C', 'O', 'M'] as const).map((k) => <span key={k}><span className={`icom-tag ${k}`}>{k}</span> {t(`icom.${k}`)}</span>)}
      </div>
    </div>
  );
}

function TreeView({ nodes, selected, onSelect, collapsed, toggle }: {
  nodes: TreeNode[]; selected?: string; onSelect: (id: string) => void; collapsed: Set<string>; toggle: (id: string) => void;
}) {
  return (
    <ul>
      {nodes.map((n) => (
        <li key={n.node.id}>
          <div className={`node ${selected === n.node.id ? 'sel' : ''}`} onClick={() => onSelect(n.node.id)}>
            <span className="toggle" onClick={(e) => { e.stopPropagation(); toggle(n.node.id); }}>
              {n.children.length ? (collapsed.has(n.node.id) ? '▸' : '▾') : '·'}
            </span>
            <span className="code">{n.node.node_code}</span>
            <span style={{ flex: 1 }}>{n.node.title}</span>
            {n.node.status === 'done' ? <span className="badge green">✓</span> : n.node.status === 'blocked' ? <span className="badge red">!</span> : null}
          </div>
          {n.children.length > 0 && !collapsed.has(n.node.id) && (
            <TreeView nodes={n.children} selected={selected} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
          )}
        </li>
      ))}
    </ul>
  );
}

export function Idef0Workspace({ projectId }: { projectId: string }) {
  const { t, lang } = useI18n();
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [acts, setActs] = useState<(Activity & Row)[] | null>(null);
  const [icoms, setIcoms] = useState<Icom[]>([]);
  const [sel, setSel] = useState<string | undefined>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<Row | null>(null);
  const [dirty, setDirty] = useState(false);
  const canWrite = can('activities', 'write');

  const load = useCallback(async () => {
    const a = (await must(supabase.from('activities').select('*').eq('project_id', projectId).order('node_code'))) as (Activity & Row)[];
    setActs(a);
    if (a.length) {
      const ic = (await must(supabase.from('activity_icoms').select('id, activity_id, icom_type, label, source_icom_id, sort, ref_type')
        .in('activity_id', a.map((x) => x.id)).order('sort'))) as Icom[];
      setIcoms(ic);
    } else setIcoms([]);
    setSel((s) => (s && a.some((x) => x.id === s) ? s : a.find((x) => !x.parent_id)?.id));
  }, [projectId]);

  useEffect(() => { void load(); }, [load]);

  const current = acts?.find((a) => a.id === sel);
  useEffect(() => { setForm(current ? { ...current } : null); setDirty(false); }, [current]);

  if (!acts) return <Spinner />;

  if (!acts.length) {
    return (
      <div className="card"><div className="card-body stack">
        <p>{t('idef.empty')}</p>
        {canWrite && (
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => run(async () => {
              await must(supabase.rpc('apply_lifecycle_template', { p_project_id: projectId, p_template_id: null, p_lang: lang }));
              await load();
            }, t('idef.templateApplied'))}>{t('idef.applyTemplate')}</button>
            <button className="btn" disabled={busy} onClick={() => run(async () => {
              await must(supabase.from('activities').insert({ project_id: projectId, title: t('idef.rootTitle') }));
              await load();
            })}>{t('idef.startBlank')}</button>
          </div>
        )}
      </div></div>
    );
  }

  const tree = buildTree(acts);
  const hasChildren = (id: string) => acts.some((a) => a.parent_id === id);
  const diagramParent = current && hasChildren(current.id) ? current : acts.find((a) => a.id === current?.parent_id) ?? current;
  const diagramChildren = acts.filter((a) => a.parent_id === diagramParent?.id);
  const crumbs = current ? ancestors(acts, current.id) : [];
  const myIcoms = icoms.filter((i) => i.activity_id === current?.id);
  const siblingOutputs = icoms.filter((i) => i.icom_type === 'O' && acts.some((a) => a.id === i.activity_id && a.parent_id === current?.parent_id && a.id !== current?.id));
  const actById = new Map(acts.map((a) => [a.id, a]));

  const addChild = () => run(async () => {
    if (!current) return;
    const { data, error } = await supabase.from('activities').insert({ project_id: projectId, parent_id: current.id, title: t('idef.newActivity'), kind: 'task' }).select().single();
    if (error) throw error;
    await load(); setSel((data as Row).id);
  });
  const move = (dir: -1 | 1) => run(async () => {
    if (!current?.parent_id) return;
    const target = current.seq + dir;
    if (target < 1 || target > 9) return;
    await must(supabase.rpc('move_activity', { p_activity_id: current.id, p_new_parent_id: current.parent_id, p_new_seq: target }));
    await load();
  });
  const remove = () => {
    if (!current || !confirm(t('idef.confirmDelete'))) return;
    void run(async () => { await must(supabase.from('activities').delete().eq('id', current.id)); setSel(current.parent_id ?? undefined); await load(); });
  };
  const saveForm = () => run(async () => {
    if (!form || !current) return;
    const payload: Row = {};
    for (const f of ACTIVITY_FIELDS) payload[f.name] = form[f.name] === '' ? null : form[f.name];
    await must(supabase.from('activities').update(payload).eq('id', current.id));
    await load();
  }, t('m.saved'));

  return (
    <div className="idef0-layout">
      <div className="card">
        <div className="card-head">
          <h3>{t('idef.tree')}</h3><div className="spacer" />
          <button className="btn sm" onClick={() => setCollapsed(new Set())}>{t('idef.expand')}</button>
          <button className="btn sm" onClick={() => setCollapsed(new Set(acts.filter((a) => a.depth >= 1 && hasChildren(a.id)).map((a) => a.id)))}>{t('idef.collapse')}</button>
        </div>
        <div className="card-body tree" style={{ maxHeight: 640, overflow: 'auto' }}>
          <TreeView nodes={tree} selected={sel} onSelect={setSel} collapsed={collapsed}
            toggle={(id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; })} />
        </div>
        {canWrite && current && (
          <div className="card-body row" style={{ borderTop: '1px solid var(--line)' }}>
            <button className="btn sm" disabled={busy} onClick={addChild}>+ {t('idef.addChild')}</button>
            <button className="btn sm" disabled={busy || !current.parent_id || current.seq <= 1} onClick={() => move(-1)}>↑</button>
            <button className="btn sm" disabled={busy || !current.parent_id || current.seq >= 9} onClick={() => move(1)}>↓</button>
            <button className="btn sm danger" disabled={busy} onClick={remove}>{t('a.delete')}</button>
          </div>
        )}
      </div>

      <div className="stack">
        <div className="card">
          <div className="card-head">
            <div className="breadcrumb">
              {crumbs.map((c, i) => (
                <span key={c.id}>{i > 0 && '› '}<a href="#" onClick={(e) => { e.preventDefault(); setSel(c.id); }}><strong>{c.node_code}</strong> {c.title}</a></span>
              ))}
            </div>
          </div>
          <div className="card-body small muted" style={{ paddingBottom: 0 }}>
            {t('idef.diagramOf', { code: diagramParent?.node_code ?? '', title: diagramParent?.title ?? '' })}
          </div>
          <Idef0Diagram items={diagramChildren} icoms={icoms} selected={sel} onSelect={setSel} />
        </div>

        {current && form && (
          <div className="grid cols-2">
            <div className="card">
              <div className="card-head">
                <h3><span className="code">{current.node_code}</span> {current.title}</h3><div className="spacer" />
                <StatusBadge value={current.status} />
                {canWrite && <button className="btn primary sm" disabled={busy || !dirty} onClick={saveForm}>{t('a.save')}</button>}
              </div>
              <div className="card-body">
                <div style={{ marginBottom: 12 }}><Progress value={current.progress_pct} /></div>
                {hasChildren(current.id) && <p className="small muted">{t('idef.rollupHint')}</p>}
                <FormGrid fields={ACTIVITY_FIELDS} row={form} setRow={(r) => { setForm(r); setDirty(true); }} disabled={!canWrite} />
              </div>
            </div>
            <IcomEditor activityId={current.id} icoms={myIcoms} siblingOutputs={siblingOutputs} actById={actById}
              canWrite={canWrite} onChanged={load} />
          </div>
        )}
      </div>
    </div>
  );
}

function IcomEditor({ activityId, icoms, siblingOutputs, actById, canWrite, onChanged }: {
  activityId: string; icoms: Icom[]; siblingOutputs: Icom[]; actById: Map<string, Activity>; canWrite: boolean; onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const { busy, run } = useAction();
  const [type, setType] = useState<'I' | 'C' | 'O' | 'M'>('I');
  const [label, setLabel] = useState('');
  const [source, setSource] = useState('');

  const add = () => run(async () => {
    const src = siblingOutputs.find((o) => o.id === source);
    const lbl = label.trim() || src?.label || '';
    if (!lbl) return;
    await must(supabase.from('activity_icoms').insert({
      activity_id: activityId, icom_type: type, label: lbl,
      source_icom_id: (type === 'I' || type === 'C') && source ? source : null,
      sort: icoms.length + 1,
    }));
    setLabel(''); setSource('');
    await onChanged();
  });

  return (
    <div className="card">
      <div className="card-head"><h3>{t('idef.icom')}</h3></div>
      <div className="card-body icom-list">
        {(['I', 'C', 'O', 'M'] as const).map((k) => (
          <div key={k} style={{ marginBottom: 8 }}>
            <div className="small muted" style={{ fontWeight: 600 }}>{t(`icom.${k}`)} — {t(`icomHelp.${k}`)}</div>
            {icoms.filter((i) => i.icom_type === k).map((i) => {
              const src = i.source_icom_id ? siblingOutputs.find((o) => o.id === i.source_icom_id) : undefined;
              const from = src ? actById.get(src.activity_id) : undefined;
              return (
                <div key={i.id} className="ic">
                  <span className={`icom-tag ${k}`}>{k}</span>
                  <span>{i.label}{from && <span className="small muted"> ← {from.node_code}</span>}</span>
                  {canWrite && <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => {
                    await must(supabase.from('activity_icoms').delete().eq('id', i.id)); await onChanged();
                  })}>✕</button>}
                </div>
              );
            })}
          </div>
        ))}
        {canWrite && (
          <div className="stack" style={{ gap: 8, marginTop: 12 }}>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <select value={type} onChange={(e) => setType(e.target.value as 'I')} style={{ width: 120 }}>
                {(['I', 'C', 'O', 'M'] as const).map((k) => <option key={k} value={k}>{k} · {t(`icom.${k}`)}</option>)}
              </select>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('idef.arrowLabel')} />
            </div>
            {(type === 'I' || type === 'C') && siblingOutputs.length > 0 && (
              <select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">{t('idef.externalArrow')}</option>
                {siblingOutputs.map((o) => <option key={o.id} value={o.id}>{actById.get(o.activity_id)?.node_code} → {o.label}</option>)}
              </select>
            )}
            <button className="btn primary sm" disabled={busy || (!label.trim() && !source)} onClick={add}>+ {t('idef.addArrow')}</button>
          </div>
        )}
      </div>
    </div>
  );
}
