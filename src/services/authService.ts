import { User } from '@supabase/supabase-js';
import { assertSupabaseConfigured, supabase } from '../lib/supabase';
import { UserProfile } from '../types/database';

export interface AuthStatePayload {
  user: User | null;
  profile: UserProfile | null;
  roles: string[];
  isAdmin: boolean;
}

/**
 * Always verifies the current user directly with Supabase Auth server.
 * Never trusts stale React state or localStorage.
 */
export async function getVerifiedSupabaseUser(): Promise<User | null> {
  assertSupabaseConfigured();
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    // AuthSessionMissingError is normal when logged out (guest)
    if (
      error.name === 'AuthSessionMissingError' ||
      error.message?.toLowerCase().includes('auth session missing') ||
      error.status === 400 ||
      error.status === 401
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
    supabase
      .from('profiles')
      .select('id, email, full_name, phone, role, created_at')
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('user_roles')
      .select('user_id, role')
      .eq('user_id', user.id),
  ]);

  if (profileRes.error && profileRes.error.code !== 'PGRST116') {
    throw new Error(`Failed to load user profile from Supabase: ${profileRes.error.message}`);
  }

  if (rolesRes.error && rolesRes.error.code !== 'PGRST116') {
    throw new Error(`Failed to load user roles from Supabase: ${rolesRes.error.message}`);
  }

  const profileData = (profileRes.data as UserProfile | null) ?? null;
  const roleRows = (rolesRes.data as Array<{ user_id: string; role: string }> | null) ?? [];

  const roleSet = new Set<string>();
  for (const row of roleRows) {
    if (row.role) {
      roleSet.add(row.role.toLowerCase());
    }
  }
  if (profileData?.role) {
    roleSet.add(profileData.role.toLowerCase());
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
}): Promise<{ user: User | null; sessionCreated: boolean }> {
  assertSupabaseConfigured();

  const { data, error } = await supabase.auth.signUp({
    email: params.email.trim(),
    password: params.password,
    options: {
      data: {
        full_name: params.fullName.trim(),
        phone: params.phone.trim(),
      },
    },
  });

  if (error) {
    throw new Error(error.message);
  }

  if (data.user && data.session) {
    // Attempt to upsert profile row under RLS if session is active
    await supabase.from('profiles').upsert(
      {
        id: data.user.id,
        email: params.email.trim(),
        full_name: params.fullName.trim(),
        phone: params.phone.trim(),
      },
      { onConflict: 'id' }
    );
  }

  return {
    user: data.user ?? null,
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
