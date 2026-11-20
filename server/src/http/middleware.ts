import type { ErrorRequestHandler, RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { ConsultantRow } from '../db/types.js';
import { AppError, badRequest, dbError, notFound, unauthorized } from '../lib/errors.js';
import type { AppDeps } from './deps.js';

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = issues[0];
    throw badRequest(first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'Invalid request', issues);
  }
  return result.data;
}

export const uuidParam = z.uuid({ error: 'Invalid id' });

/** Verifies the Supabase access token and attaches an RLS-scoped client for this user. */
export function requireAuth(deps: AppDeps): RequestHandler {
  return async (req, _res, next) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw unauthorized();
    const user = await deps.auth.verify(token);
    if (!user) throw unauthorized('Your session has expired. Please sign in again.');
    req.user = user;
    req.db = deps.userClient(token);
    next();
  };
}

/**
 * Loads the consultant from the URL through the user's RLS client. If it belongs to someone
 * else the database returns nothing and we answer 404, so ids of other tenants are not even confirmed.
 */
export function loadConsultant(): RequestHandler {
  return async (req, _res, next) => {
    const id = parse(uuidParam, req.params.consultantId);
    const { data, error } = await req
      .db!.from('consultants')
      .select('*')
      .eq('id', id)
      .eq('user_id', req.user!.id)
      .maybeSingle();
    if (error) throw dbError(error, 'loading consultant');
    if (!data) throw notFound('Consultant');
    req.consultant = data as ConsultantRow;
    next();
  };
}

export function errorHandler(deps: AppDeps): ErrorRequestHandler {
  return (err, req, res, _next) => {
    let status = 500;
    let body: { error: { code: string; message: string; details?: unknown } } = {
      error: { code: 'internal_error', message: 'Something went wrong. Please try again.' },
    };

    if (err instanceof AppError) {
      status = err.status;
      body = { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
    } else if (err instanceof multer.MulterError) {
      status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      body = {
        error: {
          code: 'upload_error',
          message:
            err.code === 'LIMIT_FILE_SIZE'
              ? `The file is too large (max ${Math.round(deps.config.limits.maxUploadBytes / 1024 / 1024)} MB)`
              : err.message,
        },
      };
    } else if ((err as { type?: string }).type === 'entity.too.large') {
      status = 413;
      body = { error: { code: 'payload_too_large', message: 'The request is too large' } };
    } else if ((err as { type?: string }).type === 'entity.parse.failed') {
      status = 400;
      body = { error: { code: 'bad_json', message: 'The request body is not valid JSON' } };
    }

    if (status >= 500) {
      deps.logger.error({ err, cause: (err as { cause?: unknown }).cause, path: req.path, method: req.method }, 'Request failed');
    }
    res.status(status).json(body);
  };
}
