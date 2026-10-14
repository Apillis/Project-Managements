import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Mode, Row } from './types';

interface AuthState {
  session: Session | null;
  profile: Row | null;
  roles: string[];
  perms: Record<string, { read: boolean; write: boolean }>;
  loading: boolean;
  can: (resource: string, mode?: Mode) => boolean;
  hasRole: (role: string) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Row | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [perms, setPerms] = useState<AuthState['perms']>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null); setRoles([]); setPerms({}); setLoading(false);
      return;
    }
    const [p, r, m] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', s.user.id).maybeSingle(),
      supabase.rpc('my_roles'),
      supabase.rpc('my_permissions'),
    ]);
    setProfile(p.data ?? null);
    setRoles(((r.data as string[] | null) ?? []).map(String));
    const map: AuthState['perms'] = {};
    for (const row of (m.data as { resource: string; can_read: boolean; can_write: boolean }[] | null) ?? []) {
      map[row.resource] = { read: row.can_read, write: row.can_write };
    }
    setPerms(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      void load(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') void load(s);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, [load]);

  const value = useMemo<AuthState>(() => ({
    session, profile, roles, perms, loading,
    can: (resource, mode = 'read') => {
      const p = perms[resource];
      return !!p && (mode === 'write' ? p.write : p.read);
    },
    hasRole: (role) => roles.includes(role),
    refresh: () => load(session),
    signOut: async () => { await supabase.auth.signOut(); },
  }), [session, profile, roles, perms, loading, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
