import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const SUPABASE_PROJECT_REF = 'fxuyajecvbgtqdfiyvcm';
export const CANONICAL_SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

const envSupabaseUrl = (import.meta.env.VITE_SUPABASE_URL?.trim() || '').replace(
  /\/+$/,
  ''
);

// Always resolve to the active production Supabase project (fxuyajecvbgtqdfiyvcm),
// preventing any stale build/deployment environment variable from targeting an old project.
export const supabaseUrl: string =
  envSupabaseUrl === CANONICAL_SUPABASE_URL ? envSupabaseUrl : CANONICAL_SUPABASE_URL;

const rawSupabaseAnonKey = (
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);

const isSecretKeyDetected = rawSupabaseAnonKey.startsWith('sb_secret_');

// Purge any cached auth tokens in localStorage from older Supabase project refs
if (typeof window !== 'undefined' && window.localStorage) {
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const key = window.localStorage.key(i);
      if (
        key &&
        key.startsWith('sb-') &&
        key.endsWith('-auth-token') &&
        !key.includes(SUPABASE_PROJECT_REF)
      ) {
        window.localStorage.removeItem(key);
      }
    }
  } catch {
    // Ignore localStorage access errors
  }
}

export const isSupabaseConfigured = Boolean(
  supabaseUrl === CANONICAL_SUPABASE_URL &&
    rawSupabaseAnonKey &&
    !isSecretKeyDetected
);

export const supabaseConfigError: string | null = isSecretKeyDetected
  ? 'Security Error: A secret key (sb_secret_...) must never be used in browser code. Use VITE_SUPABASE_ANON_KEY with the publishable/anon key.'
  : isSupabaseConfigured
    ? null
    : 'Unable to connect to the authentication service. Supabase environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are missing.';

export const supabase: SupabaseClient = createClient(
  supabaseUrl,
  isSupabaseConfigured ? rawSupabaseAnonKey : 'unconfigured-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: `sb-${SUPABASE_PROJECT_REF}-auth-token`,
    },
  }
);

export function assertSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error(
      supabaseConfigError ??
        'Unable to connect to the authentication service. Supabase environment variables are missing.'
    );
  }
}
