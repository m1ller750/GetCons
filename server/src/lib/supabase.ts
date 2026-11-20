import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config.js';

export type { SupabaseClient };

const serverAuth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } as const;

/** Service-role client. Bypasses RLS: only use after verifying ownership. */
export function createAdminClient(config: AppConfig): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.serviceRoleKey, { auth: serverAuth });
}

/**
 * A client that acts as the signed-in user, so Postgres RLS policies apply.
 * Used for every dashboard read: even a missing filter in our code cannot leak
 * another tenant's rows.
 */
export function createUserClient(config: AppConfig, accessToken: string): SupabaseClient {
  return createClient(config.supabase.url, config.supabase.anonKey, {
    auth: serverAuth,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthVerifier {
  verify(accessToken: string): Promise<AuthUser | null>;
}

/** Validates Supabase access tokens with the Auth server, with a short in-memory cache. */
export function createSupabaseAuthVerifier(admin: SupabaseClient, ttlMs = 30_000): AuthVerifier {
  const cache = new Map<string, { user: AuthUser; expires: number }>();
  return {
    async verify(token) {
      const now = Date.now();
      const hit = cache.get(token);
      if (hit && hit.expires > now) return hit.user;

      const { data, error } = await admin.auth.getUser(token);
      if (error || !data.user) {
        cache.delete(token);
        return null;
      }
      const user: AuthUser = { id: data.user.id, email: data.user.email ?? null };
      if (cache.size > 2_000) cache.clear();
      cache.set(token, { user, expires: now + ttlMs });
      return user;
    },
  };
}
