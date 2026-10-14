import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** False when the .env file has not been filled in (the UI shows a setup hint). */
export const isConfigured = Boolean(url && key && key !== 'replace-me');
export const googleEnabled = String(import.meta.env.VITE_ENABLE_GOOGLE ?? 'false') === 'true';

export const supabase = createClient(url || 'http://127.0.0.1:54321', key || 'missing-anon-key', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

export const FILES_BUCKET = 'project-files';
