import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface PublicConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  telegramMode: 'webhook' | 'polling';
}

let client: SupabaseClient | null = null;
let publicConfig: PublicConfig | null = null;

/** The backend serves the public Supabase settings, so one set of Railway variables configures everything. */
export async function initSupabase(): Promise<PublicConfig> {
  const res = await fetch('/api/public-config');
  if (!res.ok) throw new Error(`The server is not reachable (HTTP ${res.status})`);
  publicConfig = (await res.json()) as PublicConfig;
  client = createClient(publicConfig.supabaseUrl, publicConfig.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return publicConfig;
}

export function supabase(): SupabaseClient {
  if (!client) throw new Error('Supabase is not initialised');
  return client;
}

export function getPublicConfig(): PublicConfig | null {
  return publicConfig;
}
