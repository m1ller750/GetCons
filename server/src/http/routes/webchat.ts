import { createHash, randomBytes } from 'node:crypto';
import express, { Router, type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { verifySignature } from '../../core/agent/connectors.js';
import { TtlCache } from '../../core/queue.js';
import { webChatKey } from '../../core/runtime.js';
import type { ConsultantRow, MessageRow } from '../../db/types.js';
import { AppError, dbError, errorMessage, notFound } from '../../lib/errors.js';
import { owned, type AppDeps } from '../deps.js';
import { parse } from '../middleware.js';
import { planOf } from '../plan.js';
import { CHAT_JS, chatPageHtml, WIDGET_JS } from '../webchat/assets.js';

/**
 * Website channel: a public chat page (the shareable link, also shown inside the widget), the
 * widget script, the JSON API they use, and the owner's switch. Visitors are anonymous: a random
 * id kept in their browser identifies their conversation (only its hash is stored).
 */

const KEY = /^[A-Za-z0-9_-]{10,40}$/;
const keyParam = z.string().regex(KEY, { error: 'Unknown chat' });
const visitorParam = z.string().regex(/^[A-Za-z0-9_-]{16,80}$/, { error: 'Invalid visitor id' });

const sendSchema = z.object({
  visitor: visitorParam,
  text: z.string().trim().min(1).max(2000),
  name: z.string().trim().max(80).optional(),
  clientId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/).optional(),
});

const toggleSchema = z.object({ enabled: z.boolean() });

/** The visitor id is a bearer secret for their chat: only its hash is stored. */
export function visitorHash(visitor: string): string {
  return createHash('sha256').update(`getcons-web:${visitor}`).digest('base64url').slice(0, 32);
}

export function newWebKey(): string {
  return randomBytes(12).toString('base64url');
}

export function webView(c: Pick<ConsultantRow, 'web_enabled' | 'web_key'>, publicUrl: string | null) {
  const base = publicUrl ?? '';
  return {
    enabled: c.web_enabled,
    key: c.web_key,
    link: c.web_key ? `${base}/c/${c.web_key}` : null,
    widgetSnippet: c.web_key ? `<script src="${base}/widget.js" data-key="${c.web_key}" async></script>` : null,
  };
}

type PublicConsultant = Pick<ConsultantRow, 'id' | 'user_id' | 'name' | 'status' | 'business_info' | 'greeting_message' | 'web_enabled'>;

/** Public pages and API (mounted before authentication). */
export function mountWebChat(app: Express, deps: AppDeps): void {
  const byKey = new TtlCache<{ row: PublicConsultant | null }>(30_000);

  async function consultantByKey(key: string): Promise<PublicConsultant> {
    const hit = byKey.get(key);
    let row = hit?.row;
    if (!hit) {
      const { data, error } = await deps.admin
        .from('consultants')
        .select('id, user_id, name, status, business_info, greeting_message, web_enabled')
        .eq('web_key', key)
        .maybeSingle();
      if (error) throw dbError(error, 'loading the chat');
      row = (data as PublicConsultant | null) ?? null;
      byKey.set(key, { row });
    }
    if (!row || !row.web_enabled) throw notFound('Chat');
    return row;
  }

  // Pages: they may be framed by any site (that is what the widget does).
  const framable = (res: express.Response) => {
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors *; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
  };

  app.get('/c/:key', (req, res) => {
    const key = keyParam.safeParse(req.params.key);
    framable(res);
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(chatPageHtml(key.success ? key.data : 'invalid'));
  });

  app.get('/c-assets/chat.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.type('application/javascript').send(CHAT_JS);
  });

  app.get('/widget.js', (_req, res) => {
    // Loaded by other sites' pages.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.type('application/javascript').send(WIDGET_JS);
  });

  // ---- JSON API for the chat page (same origin) ---------------------------------
  const api = Router();
  api.use(express.json({ limit: '16kb' }));
  const limiter = (limit: number) =>
    rateLimit({
      windowMs: 60_000,
      limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: { code: 'rate_limited', message: 'Too many requests, slow down a little' } },
    });

  api.get('/:key', limiter(120), async (req, res) => {
    const c = await consultantByKey(parse(keyParam, req.params.key));
    const plan = await planOf(deps, c.user_id).catch(() => null);
    res.json({
      name: c.name,
      businessName: c.business_info?.businessName || null,
      greeting: c.greeting_message?.trim() || null,
      poweredBy: plan ? plan.poweredBy : true,
    });
  });

  api.post('/:key/messages', limiter(40), async (req, res) => {
    const c = await consultantByKey(parse(keyParam, req.params.key));
    const body = parse(sendSchema, req.body ?? {});
    const result = await deps.runtime.handleWeb(c.id, {
      visitor: visitorHash(body.visitor),
      text: body.text,
      name: body.name ?? null,
      clientId: body.clientId ?? null,
    });
    if (!result) throw notFound('Chat');
    res.status(202).json({ ok: true, id: result.message?.id ?? null });
  });

  api.get('/:key/messages', limiter(240), async (req, res) => {
    const c = await consultantByKey(parse(keyParam, req.params.key));
    const visitor = parse(visitorParam, req.query.visitor);
    const after = typeof req.query.after === 'string' && !Number.isNaN(Date.parse(req.query.after)) ? req.query.after : null;
    const { data: conv, error: convError } = await deps.admin
      .from('conversations')
      .select('id')
      .eq('consultant_id', c.id)
      .eq('channel', 'web')
      .eq('external_chat_id', webChatKey(visitorHash(visitor)))
      .maybeSingle();
    if (convError) throw dbError(convError, 'loading the chat');
    if (!conv) {
      res.json({ messages: [], typing: false });
      return;
    }
    const id = (conv as { id: string }).id;
    let query = deps.admin
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', id)
      .in('role', ['customer', 'assistant', 'operator']);
    query = after ? query.gt('created_at', after).order('created_at', { ascending: true }).limit(50) : query.order('created_at', { ascending: false }).limit(50);
    const { data, error } = await query;
    if (error) throw dbError(error, 'loading messages');
    const rows = (data ?? []) as Pick<MessageRow, 'id' | 'role' | 'content' | 'created_at'>[];
    if (!after) rows.reverse();
    res.json({
      messages: rows.map((m) => ({ id: m.id, role: m.role, text: m.content, at: m.created_at })),
      typing: deps.runtime.isTyping(id),
    });
  });

  app.use('/api/public/chat', api);

  // ---- Notifications pushed by the business's own site (custom API stores) --------
  app.post(
    '/api/hooks/store/:connectionId/notify',
    rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }),
    express.raw({ type: '*/*', limit: '32kb' }),
    async (req, res) => {
      const agent = deps.agent;
      const agentStore = deps.agentStore;
      const id = z.uuid().safeParse(req.params.connectionId);
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      const connection = id.success && agent && agentStore ? await agentStore.getConnectionById(id.data) : null;
      const secret = connection?.platform === 'custom' ? (agent!.credentials(connection) as { secret?: string }).secret : undefined;
      if (!connection || !secret || !verifySignature(secret, req.header('x-getcons-timestamp'), raw, req.header('x-getcons-signature'))) {
        res.status(401).json({ error: { code: 'unauthorized', message: 'Invalid signature' } });
        return;
      }
      let body: { order_id?: string; order_number?: string; message: string };
      try {
        body = parse(
          z.object({
            order_id: z.string().trim().min(1).max(200).optional(),
            order_number: z.string().trim().min(1).max(100).optional(),
            message: z.string().trim().min(1).max(1000),
          }),
          JSON.parse(raw),
        );
      } catch (err) {
        res.status(400).json({ error: { code: 'bad_request', message: err instanceof AppError ? err.message : 'Send JSON' } });
        return;
      }
      const ref = body.order_id ?? body.order_number;
      const order = ref ? await agentStore!.findOrder(connection.consultant_id, ref.replace(/^#/, '')) : null;
      if (!order) {
        res.status(404).json({ error: { code: 'not_found', message: 'No chat follows this order' } });
        return;
      }
      const delivered = await deps.runtime
        .notifyCustomer(connection.consultant_id, order.conversation_id, body.message, { order: order.number })
        .catch((err) => {
          deps.logger.warn({ err: errorMessage(err) }, 'Store notification failed');
          return false;
        });
      res.json({ ok: true, delivered });
    },
  );
}

/** The owner's switch for the website channel (mounted under /consultants/:consultantId/web). */
export function webChannelRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  router.post('/', async (req, res) => {
    const { consultant } = owned(req);
    const { enabled } = parse(toggleSchema, req.body ?? {});
    const patch: Partial<ConsultantRow> = { web_enabled: enabled };
    if (enabled && !consultant.web_key) patch.web_key = newWebKey();
    // Turning the website chat on with nothing else connected: the consultant starts answering.
    if (enabled && consultant.status === 'draft') patch.status = 'active';
    const { data, error } = await deps.admin.from('consultants').update(patch).eq('id', consultant.id).select('*').single();
    if (error) throw dbError(error, 'updating the website chat');
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, enabled ? 'web_enabled' : 'web_disabled', enabled ? 'Website chat turned on' : 'Website chat turned off');
    res.json({ web: webView(data as ConsultantRow, deps.config.publicUrl) });
  });

  router.post('/rotate', async (req, res) => {
    const { consultant } = owned(req);
    const { data, error } = await deps.admin.from('consultants').update({ web_key: newWebKey() }).eq('id', consultant.id).select('*').single();
    if (error) throw dbError(error, 'changing the chat link');
    deps.runtime.invalidate(consultant.id);
    res.json({ web: webView(data as ConsultantRow, deps.config.publicUrl) });
  });

  return router;
}
