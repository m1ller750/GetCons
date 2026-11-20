import { existsSync } from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { Router, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { AppError, errorMessage } from '../lib/errors.js';
import type { TgUpdate } from '../services/telegram/types.js';
import { authed, type AppDeps } from './deps.js';
import { errorHandler, requireAuth, uuidParam } from './middleware.js';
import { planOf } from './plan.js';
import { billingRouter, freedomPayResultHandler } from './routes/billing.js';
import { consultantsRouter } from './routes/consultants.js';
import { mountWebChat } from './routes/webchat.js';

export function createApp(deps: AppDeps): Express {
  const { config, logger } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Railway terminates TLS in front of the app

  const supabaseOrigin = new URL(config.supabase.url).origin;
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'blob:', 'https://t.me', 'https://*.telegram.org'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'", supabaseOrigin, supabaseOrigin.replace(/^http/, 'ws')],
          'frame-ancestors': ["'none'"],
          'object-src': ["'none'"],
          // Only force https when actually served over https (keeps plain-http local runs working).
          'upgrade-insecure-requests': config.publicUrl?.startsWith('https://') ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ---------------------------------------------------------------------------
  // Telegram webhooks (one URL per consultant, authenticated by a per-bot secret)
  // ---------------------------------------------------------------------------
  app.post('/telegram/webhook/:consultantId', express.json({ limit: '2mb' }), async (req, res) => {
    const id = uuidParam.safeParse(req.params.consultantId);
    const secret = req.header('x-telegram-bot-api-secret-token');
    if (!id.success || !(await deps.runtime.verifyWebhookSecret(id.data, secret))) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid webhook secret' } });
      return;
    }
    // Acknowledge immediately so Telegram never times out or retries; the reply is generated asynchronously.
    res.status(200).json({ ok: true });
    const update = req.body as TgUpdate;
    if (typeof update?.update_id !== 'number') return;
    void deps.runtime.handleUpdate(id.data, update).catch((err) => {
      logger.error({ err: errorMessage(err), consultantId: id.data }, 'Failed to handle Telegram update');
    });
  });

  // The platform manager bot (one-click creation of customers' bots).
  app.post('/telegram/manager', express.json({ limit: '1mb' }), (req, res) => {
    const manager = deps.manager;
    if (!manager?.verifyWebhookSecret(req.header('x-telegram-bot-api-secret-token'))) {
      res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid webhook secret' } });
      return;
    }
    res.status(200).json({ ok: true });
    const update = req.body as TgUpdate;
    if (typeof update?.update_id !== 'number') return;
    void manager.handleUpdate(update).catch((err) => logger.error({ err: errorMessage(err) }, 'Manager update failed'));
  });

  // Card payments: Freedom Pay calls this after a payment (form-encoded, signed).
  app.post('/api/billing/freedompay/result', ...freedomPayResultHandler(deps));

  // Website channel: public chat page, widget script and their API; store notifications.
  mountWebChat(app, deps);

  // ---------------------------------------------------------------------------
  // JSON API
  // ---------------------------------------------------------------------------
  const api = Router();
  if (config.corsOrigins.length) api.use(cors({ origin: config.corsOrigins, credentials: false }));
  api.use(express.json({ limit: '6mb' }));
  api.use(
    rateLimit({
      windowMs: 60_000,
      limit: 600,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests, slow down a little' } },
    }),
  );

  api.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), telegramMode: deps.transport.mode });
  });

  // Public values the SPA needs at runtime (the anon/publishable key is designed to be public).
  api.get('/public-config', (_req, res) => {
    res.json({
      supabaseUrl: config.supabase.url,
      supabaseAnonKey: config.supabase.anonKey,
      telegramMode: deps.transport.mode,
    });
  });

  api.use(requireAuth(deps));

  const expensive = rateLimit({
    windowMs: 60_000,
    limit: 40,
    keyGenerator: (req) => (req as express.Request).user?.id ?? 'anon',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many AI requests. Wait a minute and try again.' } },
  });
  api.use(['/consultants/:consultantId/playground', '/consultants/:consultantId/knowledge/upload'], (req, res, next) =>
    req.method === 'POST' ? expensive(req, res, next) : next(),
  );

  api.get('/me', async (req, res) => {
    const { user } = authed(req);
    const plan = await planOf(deps, user.id);
    res.json({
      user,
      plan,
      limits: config.limits,
      telegramMode: deps.transport.mode,
      models: { chat: config.gemini.model, embeddings: config.gemini.embeddingModel },
      managerBot: deps.manager?.status ?? { enabled: false, username: null, problem: 'MANAGER_BOT_TOKEN is not configured' },
      whatsapp: { enabled: Boolean(deps.whatsapp?.enabled) },
    });
  });

  api.use('/consultants', consultantsRouter(deps));
  api.use('/billing', billingRouter(deps));
  api.use(() => {
    throw new AppError(404, 'not_found', 'Unknown API endpoint');
  });

  app.use('/api', api);

  // ---------------------------------------------------------------------------
  // Frontend (built SPA)
  // ---------------------------------------------------------------------------
  const dist = deps.webDistPath;
  if (dist && existsSync(path.join(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: cacheHeaders }));
    app.get('/{*splat}', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/telegram') || req.path.startsWith('/c-assets')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(dist, 'index.html'));
    });
  }

  app.use(errorHandler(deps));
  return app;
}

function cacheHeaders(res: express.Response, filePath: string) {
  // Vite emits content-hashed assets: cache them forever.
  if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
}
