import { useState, type FormEvent } from 'react';
import { useI18n } from '../lib/i18n';
import { googleEnabled, isConfigured, supabase } from '../lib/supabase';
import { errorKey } from '../lib/api';

export function Login() {
  const { t, lang, setLang } = useI18n();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ kind: 'err' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const show = (e: unknown) => {
    const { key, raw } = errorKey(e);
    setMsg({ kind: 'err', text: key ? `${t(key)} (${raw})` : raw });
  };

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true); setMsg(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: name } } });
        if (error) throw error;
        if (!data.session) setMsg({ kind: 'ok', text: t('login.checkMail') });
      }
    } catch (e) { show(e); } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <div className="card">
        <div className="card-body stack">
          <div className="row">
            <svg width="36" height="36" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="#0f4c81" /><path d="M8 23 15 8h2l7 15h-3.2l-1.6-3.6h-6.4L11.2 23zm5-6.2h6L16 10z" fill="#fff" /></svg>
            <div><h1>Apillis PM</h1><div className="muted small">{t('app.tagline')}</div></div>
            <div style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => setLang(lang === 'vi' ? 'en' : 'vi')}>{lang === 'vi' ? 'EN' : 'VI'}</button>
          </div>
          {!isConfigured && <div className="badge red" style={{ height: 'auto', padding: 8, whiteSpace: 'normal' }}>{t('login.notConfigured')}</div>}
          {googleEnabled && (
            <button className="btn" style={{ justifyContent: 'center' }} onClick={() => supabase.auth.signInWithOAuth({
              provider: 'google', options: { redirectTo: window.location.origin, queryParams: { hd: 'apillis.com', prompt: 'select_account' } },
            })}>
              <span style={{ fontWeight: 700, color: '#4285f4' }}>G</span> {t('login.google')}
            </button>
          )}
          <form className="stack" onSubmit={submit} style={{ gap: 12 }}>
            {mode === 'signup' && (
              <label className="field">{t('f.full_name')}<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
            )}
            <label className="field">{t('f.email')}<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" placeholder="name@apillis.com" /></label>
            <label className="field">{t('login.password')}<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} /></label>
            {msg && <div className={msg.kind === 'err' ? 'err small' : 'small'} style={{ color: msg.kind === 'err' ? 'var(--danger)' : 'var(--ok)' }}>{msg.text}</div>}
            <button className="btn primary" style={{ justifyContent: 'center' }} disabled={busy}>
              {mode === 'signin' ? t('login.signIn') : t('login.signUp')}
            </button>
          </form>
          <div className="small muted">
            {mode === 'signin'
              ? <>{t('login.noAccount')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('signup'); }}>{t('login.signUp')}</a></>
              : <>{t('login.haveAccount')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('signin'); }}>{t('login.signIn')}</a></>}
          </div>
          <div className="small muted">{t('login.domainHint')}</div>
        </div>
      </div>
    </div>
  );
}
