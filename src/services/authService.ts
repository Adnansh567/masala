import { Session, User } from '@supabase/supabase-js';
import { assertSupabaseConfigured, supabase } from '../lib/supabase';
import { UserProfile } from '../types/database';

export interface AuthStatePayload {
  session: Session | null;
  user: User | null;
  profile: UserProfile | null;
  roles: string[];
  isAdmin: boolean;
}

/**
 * Retrieves the current persisted session from Supabase Auth.
 */
export async function getSupabaseSession(): Promise<Session | null> {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.getSession();
  if (error) {
    if (
      error.name === 'AuthSessionMissingError' ||
      error.message?.toLowerCase().includes('auth session missing')
    ) {
      return null;
    }
    throw new Error(`Failed to get Supabase session: ${error.message}`);
  }
  return data.session ?? null;
}

/**
 * Always verifies the current user directly with Supabase Auth server when a session exists.
 * Never trusts stale React state or localStorage alone.
 */
export async function getVerifiedSupabaseUser(): Promise<User | null> {
  assertSupabaseConfigured();

  const session = await getSupabaseSession();
  if (!session) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (
      error.name === 'AuthSessionMissingError' ||
      error.message?.toLowerCase().includes('auth session missing') ||
      error.status === 400 ||
      error.status === 401 ||
      error.status === 403
    ) {
      return null;
    }
    throw new Error(`Supabase Auth verification failed: ${error.message}`);
  }
  return data.user ?? null;
}

/**
 * Loads user profile and role assignments strictly from Supabase `profiles` and `user_roles` tables.
 * Admin status is determined exclusively from Supabase/RLS records.
 */
export async function fetchUserProfileAndRoles(user: User): Promise<{
  profile: UserProfile | null;
  roles: string[];
  isAdmin: boolean;
}> {
  assertSupabaseConfigured();

  const [profileRes, rolesRes] = await Promise.all([
    supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
    supabase.from('user_roles').select('*').eq('user_id', user.id),
  ]);

  const rawProfile =
    !profileRes.error && profileRes.data
      ? (profileRes.data as Record<string, unknown>)
      : null;

  const metadata = (user.user_metadata ?? {}) as Record<string, unknown>;

  const profileData: UserProfile = {
    id: user.id,
    email:
      (rawProfile?.email != null ? String(rawProfile.email) : null) ??
      user.email ??
      null,
    full_name:
      (rawProfile?.full_name != null ? String(rawProfile.full_name) : null) ??
      (rawProfile?.name != null ? String(rawProfile.name) : null) ??
      (metadata.full_name != null ? String(metadata.full_name) : null) ??
      null,
    phone:
      (rawProfile?.phone != null ? String(rawProfile.phone) : null) ??
      (metadata.phone != null ? String(metadata.phone) : null) ??
      user.phone ??
      null,
    role: rawProfile?.role != null ? String(rawProfile.role) : null,
    created_at:
      rawProfile?.created_at != null ? String(rawProfile.created_at) : user.created_at,
  };

  const roleRows =
    !rolesRes.error && Array.isArray(rolesRes.data)
      ? (rolesRes.data as Array<Record<string, unknown>>)
      : [];

  const roleSet = new Set<string>();
  for (const row of roleRows) {
    if (typeof row.role === 'string' && row.role.trim()) {
      roleSet.add(row.role.trim().toLowerCase());
    }
  }
  if (profileData.role && profileData.role.trim()) {
    roleSet.add(profileData.role.trim().toLowerCase());
  }

  const roles = Array.from(roleSet);
  const isAdmin = roles.includes('admin') || roles.includes('super_admin');

  return {
    profile: profileData,
    roles,
    isAdmin,
  };
}

export async function signInWithSupabase(
  email: string,
  password: string
): Promise<AuthStatePayload> {
  assertSupabaseConfigured();

  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error || !data.user) {
    throw new Error(error?.message || 'Invalid login credentials.');
  }

  const { profile, roles, isAdmin } = await fetchUserProfileAndRoles(data.user);
  return {
    session: data.session ?? null,
    user: data.user,
    profile,
    roles,
    isAdmin,
  };
}

export async function signUpWithSupabase(params: {
  email: string;
  password: string;
  fullName: string;
  phone: string;
}): Promise<{ user: User | null; session: Session | null; sessionCreated: boolean }> {
  assertSupabaseConfigured();

  const cleanEmail = params.email.trim();
  const cleanName = params.fullName.trim();
  const cleanPhone = params.phone.trim();

  const { data, error } = await supabase.auth.signUp({
    email: cleanEmail,
    password: params.password,
    options: {
      data: {
        full_name: cleanName,
        phone: cleanPhone,
      },
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data.user && data.session) {
    // Best-effort profile upsert under RLS when session is immediately active
    const { error: upsertErr } = await supabase.from('profiles').upsert(
      {
        id: data.user.id,
        full_name: cleanName,
        phone: cleanPhone,
      },
      { onConflict: 'id' }
    );
    if (upsertErr) {
      // Ignore if handled by auth trigger or restricted by schema/RLS
    }
  }

  return {
    user: data.user ?? null,
    session: data.session ?? null,
    sessionCreated: Boolean(data.session),
  };
}

export async function signOutFromSupabase(): Promise<void> {
  assertSupabaseConfigured();
  const { error } = await supabase.auth.signOut();
  if (error) {
    throw new Error(`Sign out failed: ${error.message}`);
  }
}
