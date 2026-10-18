import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { fmtDateTime } from '../lib/format';
import type { Notification } from '../lib/types';

interface NavItem { to: string; label: string; resource?: string; icon: string; badge?: number; /** also needs write on this resource */ write?: string }
interface NavGroup { label: string; items: NavItem[] }

function useNavGroups(pending: number): NavGroup[] {
  return [
    { label: 'nav.overview', items: [
      { to: '/', label: 'nav.dashboard', icon: '◧' },
      { to: '/my-tasks', label: 'nav.myTasks', icon: '☑', resource: 'activities' },
      { to: '/approvals', label: 'nav.approvals', icon: '✔', badge: pending },
      { to: '/timesheets', label: 'nav.timesheets', icon: '⏱', resource: 'timesheets' },
    ] },
    { label: 'nav.sales', items: [
      { to: '/r/cost_estimates', label: 'r.cost_estimates', icon: '∑', resource: 'costing' },
      { to: '/r/quotations', label: 'r.quotations', icon: '₫', resource: 'quotations' },
      { to: '/r/sales_orders', label: 'r.sales_orders', icon: '🗎', resource: 'sales_orders' },
      { to: '/r/partners', label: 'r.partners', icon: '👥', resource: 'partners' },
      { to: '/r/partner_contacts', label: 'r.partner_contacts', icon: '☏', resource: 'partners' },
    ] },
    { label: 'nav.projects', items: [
      { to: '/projects', label: 'r.projects', icon: '▦', resource: 'projects' },
    ] },
    { label: 'nav.engineering', items: [
      { to: '/r/boms', label: 'r.boms', icon: '☰', resource: 'bom' },
      { to: '/r/ecos', label: 'r.ecos', icon: '↻', resource: 'eco' },
      { to: '/r/documents', label: 'r.documents', icon: '🗀', resource: 'documents' },
      { to: '/r/items', label: 'r.items', icon: '⚙', resource: 'items' },
      { to: '/r/item_customer_refs', label: 'r.item_customer_refs', icon: '⇆', resource: 'items' },
    ] },
    { label: 'nav.procurement', items: [
      { to: '/r/rfqs', label: 'r.rfqs', icon: '?', resource: 'rfq' },
      { to: '/r/purchase_requests', label: 'r.purchase_requests', icon: '✎', resource: 'pr' },
      { to: '/r/purchase_orders', label: 'r.purchase_orders', icon: '🛒', resource: 'po' },
      { to: '/r/item_prices', label: 'r.item_prices', icon: '$', resource: 'costing' },
    ] },
    { label: 'nav.warehouse', items: [
      { to: '/warehouse/receiving', label: 'nav.receiving', icon: '⇩', resource: 'po_receiving' },
      { to: '/r/material_requests', label: 'r.material_requests', icon: '✎', resource: 'mr' },
      { to: '/warehouse/issue', label: 'nav.issue', icon: '⇧', resource: 'mr', write: 'warehouse' },
      { to: '/warehouse/stock', label: 'nav.stock', icon: '▤', resource: 'warehouse' },
      { to: '/r/stock_moves', label: 'r.stock_moves', icon: '⇄', resource: 'warehouse' },
    ] },
    { label: 'nav.logistics', items: [
      { to: '/r/shipments', label: 'r.shipments', icon: '🚚', resource: 'logistics' },
    ] },
    { label: 'nav.quality', items: [
      { to: '/r/inspections', label: 'r.inspections', icon: '🔍', resource: 'qa' },
      { to: '/r/ncrs', label: 'r.ncrs', icon: '⚠', resource: 'nc' },
      { to: '/r/project_compliance', label: 'r.compliance', icon: '✓', resource: 'compliance' },
    ] },
    { label: 'nav.service', items: [
      { to: '/r/service_tickets', label: 'r.service_tickets', icon: '🛠', resource: 'service' },
    ] },
    { label: 'nav.finance', items: [
      { to: '/finance', label: 'nav.finance', icon: '∑', resource: 'invoices' },
      { to: '/r/billing_milestones', label: 'r.billing_milestones', icon: '◷', resource: 'invoices' },
      { to: '/r/invoices', label: 'r.invoices', icon: '🧾', resource: 'invoices' },
      { to: '/r/payments', label: 'r.payments', icon: '₫', resource: 'payments' },
    ] },
    { label: 'nav.data', items: [
      { to: '/exports', label: 'nav.exports', icon: '⬇' },
      { to: '/import', label: 'nav.import', icon: '⬆' },
    ] },
    { label: 'nav.admin', items: [
      { to: '/settings', label: 'nav.settings', icon: '⚙', resource: 'settings' },
      { to: '/audit', label: 'nav.audit', icon: '🕮', resource: 'audit' },
    ] },
  ];
}

function Bell() {
  const { t, lang } = useI18n();
  const { session } = useAuth();
  const nav = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const uid = session?.user.id;

  const load = useCallback(async () => {
    if (!uid) return;
    const { data } = await supabase.from('notifications').select('*').order('created_at', { ascending: false }).limit(30);
    setItems((data as Notification[]) ?? []);
  }, [uid]);

  useEffect(() => {
    void load();
    if (!uid) return;
    const ch = supabase.channel('notif-' + uid)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${uid}` }, () => void load())
      .subscribe();
    const timer = setInterval(() => void load(), 60000);
    return () => { void supabase.removeChannel(ch); clearInterval(timer); };
  }, [uid, load]);

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const unread = items.filter((i) => !i.is_read).length;
  return (
    <div className="bell" ref={box} style={{ position: 'relative' }}>
      <button className="btn ghost icon" onClick={() => setOpen(!open)} aria-label={t('nav.notifications')}>🔔</button>
      {unread > 0 && <span className="count">{unread}</span>}
      {open && (
        <div className="popover">
          <div className="row" style={{ padding: '8px 14px', borderBottom: '1px solid var(--line)' }}>
            <strong>{t('nav.notifications')}</strong><div style={{ flex: 1 }} />
            {unread > 0 && <button className="btn sm" onClick={async () => { await supabase.rpc('mark_notifications_read', { p_ids: null }); void load(); }}>{t('a.markAllRead')}</button>}
          </div>
          {items.length === 0 && <div className="empty">{t('m.noNotifications')}</div>}
          {items.map((n) => (
            <div key={n.id} className={`item ${n.is_read ? '' : 'unread'}`} onClick={async () => {
              if (!n.is_read) await supabase.rpc('mark_notifications_read', { p_ids: [n.id] });
              setOpen(false); void load();
              if (n.link) nav(n.link);
            }}>
              <div className="t">{n.title}</div>
              {n.body && <div className="small">{n.body}</div>}
              <div className="small muted">{fmtDateTime(n.created_at, lang)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const { can, profile, signOut, session } = useAuth();
  const [pending, setPending] = useState(0);
  const [menu, setMenu] = useState(false);
  const loc = useLocation();

  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => {
    let alive = true;
    const load = () => supabase.rpc('my_pending_approvals').then(({ data }) => { if (alive) setPending(((data as unknown[]) ?? []).length); });
    void load();
    const timer = setInterval(load, 60000);
    return () => { alive = false; clearInterval(timer); };
  }, [loc.pathname, session?.user.id]);

  const groups = useNavGroups(pending)
    .map((g) => ({ ...g, items: g.items.filter((i) => (!i.resource || can(i.resource, 'read')) && (!i.write || can(i.write, 'write'))) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="shell">
      <aside className={`sidebar ${menu ? 'open' : ''}`}>
        <div className="logo">
          <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#1d6fb8" /><path d="M8 23 15 8h2l7 15h-3.2l-1.6-3.6h-6.4L11.2 23zm5-6.2h6L16 10z" fill="#fff" /></svg>
          <div>Apillis PM<span>{t('app.tagline')}</span></div>
        </div>
        {groups.map((g) => (
          <div key={g.label}>
            <div className="nav-group">{t(g.label)}</div>
            <nav className="nav">
              {g.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.to === '/'}>
                  <span style={{ width: 18, textAlign: 'center' }}>{i.icon}</span>{t(i.label)}
                  {!!i.badge && <span className="count badge">{i.badge}</span>}
                </NavLink>
              ))}
            </nav>
          </div>
        ))}
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn ghost icon burger" onClick={() => setMenu(!menu)} aria-label="menu">☰</button>
          <div className="spacer" />
          <div className="row" role="group" aria-label="language">
            <button className={`btn sm ${lang === 'vi' ? 'primary' : ''}`} onClick={() => setLang('vi')}>VI</button>
            <button className={`btn sm ${lang === 'en' ? 'primary' : ''}`} onClick={() => setLang('en')}>EN</button>
          </div>
          <Bell />
          <NavLink to="/profile" className="small">{profile?.full_name || profile?.email}</NavLink>
          <button className="btn sm" onClick={() => void signOut()}>{t('a.signOut')}</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
