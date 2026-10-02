import { createClient, SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_SUPABASE_URL = 'https://fxuyajecvbgtqdfiyvcm.supabase.co';

const rawSupabaseUrl = (
  import.meta.env.VITE_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL
).replace(/\/+$/, '');

const rawSupabaseAnonKey = (
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  ''
);

const isSecretKeyDetected = rawSupabaseAnonKey.startsWith('sb_secret_');

export const isSupabaseConfigured = Boolean(
  rawSupabaseUrl &&
    rawSupabaseAnonKey &&
    rawSupabaseUrl.startsWith('https://') &&
    !rawSupabaseUrl.includes('placeholder') &&
    !rawSupabaseUrl.includes('unconfigured-project') &&
    !isSecretKeyDetected
);

export const supabaseConfigError: string | null = isSecretKeyDetected
  ? 'Security Error: A secret key (sb_secret_...) must never be used in browser code. Use VITE_SUPABASE_ANON_KEY with the publishable/anon key.'
  : isSupabaseConfigured
    ? null
    : 'Unable to connect to the authentication service. Supabase environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are missing.';

export const supabase: SupabaseClient = createClient(
  isSupabaseConfigured ? rawSupabaseUrl : DEFAULT_SUPABASE_URL,
  isSupabaseConfigured ? rawSupabaseAnonKey : 'unconfigured-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'kbr-masale-supabase-auth',
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
