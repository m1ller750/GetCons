export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Authentication required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const tooLarge = (message: string) => new AppError(413, 'payload_too_large', message);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, 'unprocessable', message, details);
export const tooManyRequests = (message: string) => new AppError(429, 'rate_limited', message);
export const upstream = (message: string, details?: unknown) => new AppError(502, 'upstream_error', message, details);

/** Wraps a Supabase/PostgREST error into an AppError without leaking internals to clients. */
export function dbError(err: { message?: string; code?: string } | null | undefined, context: string): AppError {
  const e = new AppError(500, 'database_error', `Database error while ${context}`);
  (e as AppError & { cause?: unknown }).cause = err;
  return e;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
