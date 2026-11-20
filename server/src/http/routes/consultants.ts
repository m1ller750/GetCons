import { Router } from 'express';
import { z } from 'zod';
import { fillTemplate, getTemplate, TEMPLATE_IDS, TEMPLATES } from '../../core/templates.js';
import type { BotRequestRow } from '../../db/managerStore.js';
import type { ConsultantRow } from '../../db/types.js';
import { encryptSecret, randomCode, randomToken } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, dbError, errorMessage, upstream } from '../../lib/errors.js';
import { BOT_TOKEN_PATTERN, TelegramError } from '../../services/telegram/client.js';
import { authed, owned, type AppDeps } from '../deps.js';
import { loadConsultant, parse } from '../middleware.js';
import { planOf, planRequired } from '../plan.js';
import { readAgentSettings } from '../../core/agent/settings.js';
import { agentRouter } from './agent.js';
import { activityRouter, analyticsRouter } from './analytics.js';
import { webChannelRouter, webView } from './webchat.js';
import { conversationsRouter } from './conversations.js';
import { examplesRouter } from './examples.js';
import { knowledgeRouter } from './knowledge.js';
import { playgroundRouter } from './playground.js';

const businessInfoSchema = z
  .object({
    businessName: z.string().max(200),
    description: z.string().max(8000),
    products: z.string().max(8000),
    pricing: z.string().max(8000),
    hours: z.string().max(2000),
    location: z.string().max(2000),
    contacts: z.string().max(2000),
    delivery: z.string().max(4000),
    policies: z.string().max(8000),
    website: z.string().max(1000),
    extra: z.string().max(8000),
  })
  .partial()
  .strict();

const createSchema = z.object({
  name: z.string().trim().min(1).max(80).default('Alex'),
  businessName: z.string().trim().max(200).optional(),
  description: z.string().trim().max(8000).optional(),
  template: z.enum(TEMPLATE_IDS).default('general'),
  language: z.string().trim().min(2).max(40).default('auto'),
  botToken: z.string().trim().optional(),
  /** One click: also ask Telegram to create the bot (Managed Bots). */
  createBot: z.boolean().default(false),
});

/** Dashboard view of a one-click creation request. */
export function botRequestView(row: BotRequestRow, deps: AppDeps) {
  const expired = row.status === 'pending' && row.expires_at < new Date().toISOString();
  const links = deps.manager?.linksFor(row) ?? { link: null, fallbackLink: null };
  return {
    id: row.id,
    status: expired ? 'expired' : row.status,
    suggestedUsername: row.suggested_username,
    suggestedName: row.suggested_name,
    botUsername: row.bot_username,
    error: row.error,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    ...links,
  };
}

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    instructions: z.string().max(12000),
    tone: z.enum(['friendly', 'professional', 'formal', 'playful', 'concise']),
    language: z.string().trim().min(2).max(40),
    use_emojis: z.boolean(),
    strictness: z.enum(['strict', 'balanced']),
    business_info: businessInfoSchema,
    greeting_message: z.string().max(2000),
    fallback_message: z.string().max(2000),
    temperature: z.number().min(0).max(1.5),
    max_history_messages: z.number().int().min(2).max(60),
    handoff_enabled: z.boolean(),
  })
  .partial()
  .strict();

const statusSchema = z.object({ status: z.enum(['active', 'paused']) });
const tokenSchema = z.object({
  botToken: z
    .string()
    .trim()
    .regex(BOT_TOKEN_PATTERN, 'This does not look like a bot token. Copy it from @BotFather, e.g. 123456789:AAE...'),
});

const whatsappConnectSchema = z.object({
  method: z.enum(['qr', 'code']).default('qr'),
  phone: z.string().trim().max(32).optional(),
});

/** What the dashboard sees. Secrets live in another table and are never returned. */
export function consultantView(c: ConsultantRow, deps: AppDeps) {
  const { owner_whatsapp_jid: ownerWhatsApp, ...row } = c;
  return {
    ...row,
    telegram: {
      connected: Boolean(c.telegram_bot_id),
      mode: deps.transport.mode,
      botUsername: c.telegram_bot_username,
      botName: c.telegram_bot_name,
      connectedAt: c.telegram_connected_at,
      ownerNotifications: Boolean(c.owner_chat_id),
    },
    whatsapp: {
      enabled: Boolean(deps.whatsapp?.enabled),
      connected: c.whatsapp_status === 'connected',
      status: c.whatsapp_status,
      phone: c.whatsapp_phone,
      name: c.whatsapp_name,
      connectedAt: c.whatsapp_connected_at,
      ownerNotifications: Boolean(ownerWhatsApp),
    },
    web: webView(c, deps.config.publicUrl),
    agent: readAgentSettings(c.agent),
  };
}

const hasChannel = (c: ConsultantRow) => Boolean(c.telegram_bot_id) || c.whatsapp_status === 'connected' || c.web_enabled;

export function consultantsRouter(deps: AppDeps): Router {
  const router = Router();

  router.get('/templates', (_req, res) => {
    res.json({ templates: TEMPLATES.map((t) => ({ id: t.id, label: t.label, tone: t.tone })) });
  });

  router.get('/', async (req, res) => {
    const { db, user } = authed(req);
    const { data, error } = await db
      .from('consultants')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true });
    if (error) throw dbError(error, 'listing consultants');
    res.json({ consultants: (data as ConsultantRow[]).map((c) => consultantView(c, deps)) });
  });

  // One-click creation: sensible defaults from a template; optionally connects Telegram right away.
  router.post('/', async (req, res) => {
    const { db, user } = authed(req);
    const body = parse(createSchema, req.body ?? {});

    const plan = await planOf(deps, user.id);
    const maxConsultants = Math.min(plan.maxConsultants, deps.config.limits.maxConsultantsPerUser);
    const limitReached = () =>
      new AppError(403, 'limit_reached', `Your plan allows ${maxConsultants} consultant(s). Choose a bigger plan to add more.`, {
        plan: plan.id,
        max: maxConsultants,
      });
    const { count, error: countError } = await db
      .from('consultants')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id);
    if (countError) throw dbError(countError, 'counting consultants');
    if ((count ?? 0) >= maxConsultants) throw limitReached();

    const tpl = getTemplate(body.template);
    const { data, error } = await deps.admin
      .from('consultants')
      .insert({
        user_id: user.id,
        name: body.name,
        template: tpl.id,
        tone: tpl.tone,
        language: body.language,
        instructions: tpl.instructions,
        greeting_message: fillTemplate(tpl.greeting, body.businessName),
        fallback_message: tpl.fallback,
        business_info: {
          ...(body.businessName ? { businessName: body.businessName } : {}),
          ...(body.description ? { description: body.description } : {}),
        },
      })
      .select('*')
      .single();
    // The database enforces the plan cap too (parallel requests); its error means the same thing.
    if (error?.code === 'P0001' && /limit/i.test(error.message)) throw limitReached();
    if (error) throw dbError(error, 'creating consultant');
    const consultant = data as ConsultantRow;

    const secret = await deps.admin
      .from('consultant_secrets')
      .insert({ consultant_id: consultant.id, webhook_secret: randomToken(32) });
    if (secret.error) throw dbError(secret.error, 'creating consultant secrets');

    await deps.store.logEvent(consultant.id, 'consultant_created', `Consultant "${consultant.name}" created`);

    let result = consultant;
    let telegramError: string | null = null;
    let botRequest: ReturnType<typeof botRequestView> | null = null;
    if (body.botToken) {
      try {
        result = await connectTelegram(deps, consultant, body.botToken);
      } catch (err) {
        telegramError = errorMessage(err);
      }
    } else if (body.createBot && deps.manager?.enabled) {
      try {
        botRequest = botRequestView((await deps.manager.createLink(consultant)).request, deps);
      } catch (err) {
        telegramError = errorMessage(err);
      }
    }
    res.status(201).json({ consultant: consultantView(result, deps), telegramError, botRequest });
  });

  // Everything below is scoped to one consultant that must belong to the caller.
  router.use('/:consultantId', loadConsultant());
  router.use('/:consultantId/knowledge', knowledgeRouter(deps));
  router.use('/:consultantId/examples', examplesRouter(deps));
  router.use('/:consultantId/conversations', conversationsRouter(deps));
  router.use('/:consultantId/analytics', analyticsRouter(deps));
  router.use('/:consultantId/activity', activityRouter(deps));
  router.use('/:consultantId/playground', playgroundRouter(deps));
  router.use('/:consultantId/agent', agentRouter(deps));
  router.use('/:consultantId/web', webChannelRouter(deps));

  router.get('/:consultantId', async (req, res) => {
    const { consultant, db } = owned(req);
    const [docs, examples, conversations] = await Promise.all([
      db.from('knowledge_documents').select('id', { count: 'exact', head: true }).eq('consultant_id', consultant.id),
      db.from('training_examples').select('id', { count: 'exact', head: true }).eq('consultant_id', consultant.id),
      db
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('consultant_id', consultant.id)
        .neq('channel', 'playground'),
    ]);
    res.json({
      consultant: consultantView(consultant, deps),
      counts: { documents: docs.count ?? 0, examples: examples.count ?? 0, conversations: conversations.count ?? 0 },
    });
  });

  router.patch('/:consultantId', async (req, res) => {
    const { consultant } = owned(req);
    const patch = parse(updateSchema, req.body ?? {});
    if (!Object.keys(patch).length) throw badRequest('Nothing to update');
    const { data, error } = await deps.admin
      .from('consultants')
      .update(patch)
      .eq('id', consultant.id)
      .select('*')
      .single();
    if (error) throw dbError(error, 'updating consultant');
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, 'settings_updated', `Settings updated: ${Object.keys(patch).join(', ')}`);

    const updated = data as ConsultantRow;
    if (patch.business_info && updated.telegram_bot_id) void syncBotProfile(deps, updated);
    res.json({ consultant: consultantView(updated, deps) });
  });

  router.delete('/:consultantId', async (req, res) => {
    const { consultant } = owned(req);
    const ctx = await deps.runtime.getContext(consultant.id);
    if (ctx?.client) await deps.transport.detach(consultant.id, ctx.client).catch(() => undefined);
    if (consultant.whatsapp_status !== 'disconnected') await deps.whatsapp?.disconnect(consultant.id).catch(() => undefined);
    const { error } = await deps.admin.from('consultants').delete().eq('id', consultant.id);
    if (error) throw dbError(error, 'deleting consultant');
    deps.runtime.invalidate(consultant.id);
    res.status(204).end();
  });

  router.post('/:consultantId/status', async (req, res) => {
    const { consultant } = owned(req);
    const { status } = parse(statusSchema, req.body ?? {});
    if (status === 'active' && !hasChannel(consultant)) {
      throw new AppError(409, 'channel_not_connected', 'Connect WhatsApp, Telegram or the website chat before activating the consultant');
    }
    const { data, error } = await deps.admin
      .from('consultants')
      .update({ status, last_error: status === 'active' ? null : consultant.last_error })
      .eq('id', consultant.id)
      .select('*')
      .single();
    if (error) throw dbError(error, 'updating status');
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(
      consultant.id,
      status === 'active' ? 'consultant_resumed' : 'consultant_paused',
      status === 'active' ? 'AI replies resumed' : 'AI replies paused: messages are still collected',
    );
    res.json({ consultant: consultantView(data as ConsultantRow, deps) });
  });

  // ---- One-click bot creation (Telegram Managed Bots) ---------------------------

  router.post('/:consultantId/telegram/create-bot', async (req, res) => {
    const { consultant } = owned(req);
    if (!deps.manager?.enabled) {
      throw new AppError(409, 'manager_bot_disabled', deps.manager?.status.problem ?? 'One-click bot creation is not configured');
    }
    if (consultant.telegram_bot_id) throw conflict('This consultant already has a Telegram bot');
    const { request } = await deps.manager.createLink(consultant);
    res.status(201).json({ request: botRequestView(request, deps) });
  });

  router.get('/:consultantId/telegram/create-bot', async (req, res) => {
    const { consultant, db } = owned(req);
    const { data, error } = await db
      .from('bot_creation_requests')
      .select('*')
      .eq('consultant_id', consultant.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw dbError(error, 'loading bot request');
    res.json({ request: data ? botRequestView(data as BotRequestRow, deps) : null });
  });

  // ---- Telegram connection ----------------------------------------------------

  router.post('/:consultantId/telegram', async (req, res) => {
    const { consultant } = owned(req);
    const { botToken } = parse(tokenSchema, req.body ?? {});
    const updated = await connectTelegram(deps, consultant, botToken);
    res.json({ consultant: consultantView(updated, deps) });
  });

  router.get('/:consultantId/telegram', async (req, res) => {
    const { consultant } = owned(req);
    if (!consultant.telegram_bot_id) {
      res.json({ connected: false, mode: deps.transport.mode });
      return;
    }
    const ctx = await deps.runtime.getContext(consultant.id);
    let webhook: Record<string, unknown> | null = null;
    let problem: string | null = consultant.last_error;
    if (ctx?.client && deps.transport.mode === 'webhook') {
      try {
        const info = await ctx.client.getWebhookInfo();
        webhook = {
          ok: info.url === `${deps.config.publicUrl}/telegram/webhook/${consultant.id}`,
          pendingUpdates: info.pending_update_count,
          lastErrorMessage: info.last_error_message ?? null,
          lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
        };
      } catch (err) {
        problem = err instanceof TelegramError && err.isUnauthorized ? 'Telegram rejected the bot token' : errorMessage(err);
      }
    }
    res.json({
      connected: true,
      mode: deps.transport.mode,
      bot: { id: consultant.telegram_bot_id, username: consultant.telegram_bot_username, name: consultant.telegram_bot_name },
      webhook,
      problem,
    });
  });

  router.delete('/:consultantId/telegram', async (req, res) => {
    const { consultant } = owned(req);
    const ctx = await deps.runtime.getContext(consultant.id);
    if (ctx?.client) await deps.transport.detach(consultant.id, ctx.client).catch(() => undefined);
    const secrets = await deps.admin
      .from('consultant_secrets')
      .update({ bot_token_ciphertext: null })
      .eq('consultant_id', consultant.id);
    if (secrets.error) throw dbError(secrets.error, 'removing bot token');
    const { data, error } = await deps.admin
      .from('consultants')
      .update({
        // still answering in WhatsApp? then it stays active
        status: consultant.whatsapp_status === 'connected' ? consultant.status : 'draft',
        telegram_bot_id: null,
        telegram_bot_username: null,
        telegram_bot_name: null,
        telegram_connected_at: null,
        owner_chat_id: null,
        owner_link_code: null,
        last_error: null,
      })
      .eq('id', consultant.id)
      .select('*')
      .single();
    if (error) throw dbError(error, 'disconnecting bot');
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, 'telegram_disconnected', 'Telegram bot disconnected');
    res.json({ consultant: consultantView(data as ConsultantRow, deps) });
  });

  // ---- WhatsApp: link a work number as a device ---------------------------------

  router.get('/:consultantId/whatsapp', async (req, res) => {
    const { consultant } = owned(req);
    if (!deps.whatsapp) {
      res.json({ whatsapp: { enabled: false, status: 'disconnected' } });
      return;
    }
    res.json({ whatsapp: deps.whatsapp.view(consultant) });
  });

  router.post('/:consultantId/whatsapp/connect', async (req, res) => {
    const { consultant } = owned(req);
    if (!deps.whatsapp?.enabled) throw new AppError(409, 'whatsapp_disabled', 'WhatsApp is not enabled on this server');
    const body = parse(whatsappConnectSchema, req.body ?? {});
    const whatsapp = await deps.whatsapp.connect(consultant, { method: body.method, phone: body.phone ?? null });
    res.json({ whatsapp });
  });

  router.delete('/:consultantId/whatsapp', async (req, res) => {
    const { consultant } = owned(req);
    if (deps.whatsapp) await deps.whatsapp.disconnect(consultant.id);
    else await deps.store.updateConsultant(consultant.id, { whatsapp_status: 'disconnected', whatsapp_phone: null, owner_whatsapp_jid: null });
    if (!consultant.telegram_bot_id) await deps.store.updateConsultant(consultant.id, { status: 'draft' }); // no channel left
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, 'whatsapp_disconnected', 'WhatsApp number unlinked');
    const fresh = (await deps.store.getConsultant(consultant.id)) ?? consultant;
    res.json({ consultant: consultantView(fresh, deps) });
  });

  // ---- Owner notifications (the owner links their own Telegram or WhatsApp chat) --

  router.post('/:consultantId/owner-link', async (req, res) => {
    const { consultant, user } = owned(req);
    if (!(await planOf(deps, user.id)).ownerAlerts) {
      throw planRequired('ownerAlerts', 'Owner alerts are included in the Business and Pro plans');
    }
    if (!hasChannel(consultant)) {
      throw new AppError(409, 'channel_not_connected', 'Connect WhatsApp or Telegram first');
    }
    const code = randomCode();
    const { error } = await deps.admin.from('consultants').update({ owner_link_code: code }).eq('id', consultant.id);
    if (error) throw dbError(error, 'creating link code');
    deps.runtime.invalidate(consultant.id);
    res.json({
      code,
      botUsername: consultant.telegram_bot_username,
      whatsappPhone: consultant.whatsapp_status === 'connected' ? consultant.whatsapp_phone : null,
      command: `/connect ${code}`,
    });
  });

  router.delete('/:consultantId/owner-link', async (req, res) => {
    const { consultant } = owned(req);
    const { data, error } = await deps.admin
      .from('consultants')
      .update({ owner_chat_id: null, owner_whatsapp_jid: null, owner_link_code: null })
      .eq('id', consultant.id)
      .select('*')
      .single();
    if (error) throw dbError(error, 'disabling notifications');
    deps.runtime.invalidate(consultant.id);
    res.json({ consultant: consultantView(data as ConsultantRow, deps) });
  });

  return router;
}

/** Validates the token with Telegram, stores it encrypted and starts receiving updates. */
export async function connectTelegram(deps: AppDeps, consultant: ConsultantRow, botToken: string): Promise<ConsultantRow> {
  if (!BOT_TOKEN_PATTERN.test(botToken)) {
    throw badRequest('This does not look like a bot token. Copy it from @BotFather, e.g. 123456789:AAE...');
  }
  const client = deps.telegram(botToken);
  let me;
  try {
    me = await client.getMe();
  } catch (err) {
    if (err instanceof TelegramError && err.isUnauthorized) {
      throw badRequest('Telegram rejected this token. Check it in @BotFather (or issue a new one with /token).');
    }
    throw upstream(`Could not reach Telegram: ${errorMessage(err)}`);
  }

  const { data: taken, error: takenError } = await deps.admin
    .from('consultants')
    .select('id')
    .eq('telegram_bot_id', me.id)
    .neq('id', consultant.id)
    .maybeSingle();
  if (takenError) throw dbError(takenError, 'checking bot');
  if (taken) throw conflict(`@${me.username} is already connected to another consultant. Disconnect it there first.`);

  // Stop the previously connected bot, if it was a different one.
  const previous = await deps.runtime.getContext(consultant.id);
  if (previous?.client && consultant.telegram_bot_id && consultant.telegram_bot_id !== me.id) {
    await deps.transport.detach(consultant.id, previous.client).catch(() => undefined);
  }

  const { data: secretRow, error: secretReadError } = await deps.admin
    .from('consultant_secrets')
    .select('webhook_secret')
    .eq('consultant_id', consultant.id)
    .maybeSingle();
  if (secretReadError) throw dbError(secretReadError, 'loading secrets');
  const webhookSecret = (secretRow as { webhook_secret: string | null } | null)?.webhook_secret || randomToken(32);

  const { error: secretError } = await deps.admin.from('consultant_secrets').upsert({
    consultant_id: consultant.id,
    bot_token_ciphertext: encryptSecret(botToken, deps.config.encryptionKey),
    webhook_secret: webhookSecret,
  });
  if (secretError) throw dbError(secretError, 'saving bot token');

  try {
    await deps.transport.attach(consultant.id, client, webhookSecret);
  } catch (err) {
    throw upstream(`Telegram did not accept the webhook: ${errorMessage(err)}`);
  }

  const { data, error } = await deps.admin
    .from('consultants')
    .update({
      telegram_bot_id: me.id,
      telegram_bot_username: me.username ?? null,
      telegram_bot_name: me.first_name,
      telegram_connected_at: new Date().toISOString(),
      status: 'active',
      last_error: null,
    })
    .eq('id', consultant.id)
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') throw conflict('This bot is already connected to another consultant');
    throw dbError(error, 'saving bot');
  }
  deps.runtime.invalidate(consultant.id);
  const updated = data as ConsultantRow;
  await deps.store.logEvent(consultant.id, 'telegram_connected', `Connected to Telegram bot @${me.username}`, {
    meta: { bot_id: me.id, mode: deps.transport.mode },
  });
  void syncBotProfile(deps, updated);
  return updated;
}

/** Best effort: bot commands and description shown in Telegram before the first message. */
async function syncBotProfile(deps: AppDeps, consultant: ConsultantRow): Promise<void> {
  try {
    const ctx = await deps.runtime.getContext(consultant.id);
    if (!ctx?.client) return;
    await ctx.client.setMyCommands([
      { command: 'start', description: 'Start the conversation' },
      { command: 'reset', description: 'Start over (clear conversation context)' },
    ]);
    const info = consultant.business_info ?? {};
    const short = info.businessName ? `AI consultant of ${info.businessName}` : 'AI consultant';
    await ctx.client.setMyShortDescription(short);
    const description = info.description?.trim()
      ? `${info.description.trim().slice(0, 400)}\n\nAsk me anything - I answer 24/7.`
      : 'Ask me anything - I answer 24/7.';
    await ctx.client.setMyDescription(description);
  } catch (err) {
    deps.logger.warn({ consultantId: consultant.id, err: errorMessage(err) }, 'Could not update bot profile');
  }
}
