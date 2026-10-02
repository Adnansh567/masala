import { createClient, SupabaseClient } from '@supabase/supabase-js';

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
const rawSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ?? '';

export const isSupabaseConfigured = Boolean(
  rawSupabaseUrl &&
    rawSupabaseAnonKey &&
    rawSupabaseUrl.startsWith('http') &&
    !rawSupabaseUrl.includes('placeholder')
);

export const supabaseConfigError: string | null = isSupabaseConfigured
  ? null
  : 'Supabase environment variables (VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY) are not configured or invalid.';

// Use a valid syntactic URL only to instantiate the client object; all service calls
// explicitly assertConfiguration() so failed/unconfigured requests throw real errors
// and never return fake or demo data.
export const supabase: SupabaseClient = createClient(
  isSupabaseConfigured ? rawSupabaseUrl : 'https://unconfigured-project.supabase.co',
  isSupabaseConfigured ? rawSupabaseAnonKey : 'unconfigured-anon-key',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);

export function assertSupabaseConfigured(): void {
  if (!isSupabaseConfigured) {
    throw new Error(
      supabaseConfigError ??
        'Supabase is not configured. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
    );
  }
}
