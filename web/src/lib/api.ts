import { en } from '../i18n/en';
import { ru } from '../i18n/ru';
import { supabase } from './supabase';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  form?: FormData;
  signal?: AbortSignal;
}

/** Calls the GetCons backend with the current Supabase session token. */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const headers: Record<string, string> = {};
  if (data.session?.access_token) headers.Authorization = `Bearer ${data.session.access_token}`;
  let body: BodyInit | undefined;
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: options.method ?? 'GET', headers, body, signal: options.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'network', 'Network error: check your connection');
  }
  if (res.status === 204) return undefined as T;
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401) void supabase().auth.signOut();
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return json as T;
}

/** Plan limits come back as codes; they are shown in the user's language with a pointer to Billing. */
function planMessage(code: string): string | null {
  const t = document.documentElement.lang === 'ru' ? ru : en;
  if (code === 'plan_required') return t.billing.planError;
  if (code === 'reply_limit_reached') return t.billing.replyLimit;
  if (code === 'limit_reached') return t.create.limit;
  return null;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const plan = planMessage(err.code);
    if (plan && (err.code !== 'limit_reached' || /consultant/i.test(err.message))) return plan;
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
