import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { createConnector, normalizeStoreUrl, StoreError, type StoreCredentials } from '../../core/agent/connectors.js';
import { conversationLang } from '../../core/agent/service.js';
import { agentSettingsInput, mergeAgentSettings, readAgentSettings } from '../../core/agent/settings.js';
import type { AgentActionRow, StoreConnectionRow } from '../../db/agentStore.js';
import type { ConsultantRow, ConversationRow } from '../../db/types.js';
import { encryptSecret, randomToken } from '../../lib/crypto.js';
import { AppError, badRequest, dbError, errorMessage } from '../../lib/errors.js';
import { owned, type AppDeps } from '../deps.js';
import { parse, uuidParam } from '../middleware.js';
import { planOf, planRequired } from '../plan.js';

const connectSchema = z.discriminatedUnion('platform', [
  z.object({ platform: z.literal('shopify'), storeUrl: z.string().trim().min(3).max(300), accessToken: z.string().trim().min(10).max(200) }),
  z.object({
    platform: z.literal('woocommerce'),
    storeUrl: z.string().trim().min(4).max(300),
    consumerKey: z.string().trim().regex(/^ck_[A-Za-z0-9]{20,80}$/, 'The consumer key starts with ck_'),
    consumerSecret: z.string().trim().regex(/^cs_[A-Za-z0-9]{20,80}$/, 'The consumer secret starts with cs_'),
  }),
  z.object({ platform: z.literal('custom'), storeUrl: z.string().trim().min(8).max(500) }),
]);

const rejectSchema = z.object({ reason: z.string().trim().max(500).default('') });

export function connectionView(c: StoreConnectionRow | null) {
  if (!c) return null;
  return {
    id: c.id,
    platform: c.platform,
    storeUrl: c.store_url,
    storeName: c.store_name,
    currency: c.currency,
    status: c.status,
    lastError: c.last_error,
    connectedAt: c.created_at,
  };
}

function actionView(a: AgentActionRow, conversation: Pick<ConversationRow, 'customer_name' | 'channel'> | undefined) {
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    summary: a.summary,
    amount: a.amount === null ? null : Number(a.amount),
    currency: a.currency,
    externalRef: a.external_ref,
    error: a.error,
    conversationId: a.conversation_id,
    customerName: conversation?.customer_name ?? null,
    channel: conversation?.channel ?? null,
    createdAt: a.created_at,
    executedAt: a.executed_at,
  };
}

function requireAgent(deps: AppDeps) {
  if (!deps.agent || !deps.agentStore) throw new AppError(503, 'agent_unavailable', 'The agent is not available on this server');
  return { agent: deps.agent, agentStore: deps.agentStore };
}

/** The owner's agent settings, store connection and approvals (mounted under /consultants/:consultantId/agent). */
export function agentRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res) => {
    const { consultant, user } = owned(req);
    const { agent } = requireAgent(deps);
    const [plan, connection] = await Promise.all([planOf(deps, user.id), agent.connection(consultant.id)]);
    res.json({
      available: plan.agent,
      settings: readAgentSettings(consultant.agent),
      connection: connectionView(connection),
      notifyUrl: connection?.platform === 'custom' && deps.config.publicUrl ? `${deps.config.publicUrl}/api/hooks/store/${connection.id}/notify` : null,
    });
  });

  router.put('/', async (req, res) => {
    const { consultant, user } = owned(req);
    const { agent } = requireAgent(deps);
    const patch = parse(agentSettingsInput, req.body ?? {});
    const next = mergeAgentSettings(readAgentSettings(consultant.agent), patch);
    if (next.enabled && !(await planOf(deps, user.id)).agent) {
      throw planRequired('agent', 'The AI agent is part of the Pro plan');
    }
    const { error } = await deps.admin.from('consultants').update({ agent: next }).eq('id', consultant.id);
    if (error) throw dbError(error, 'saving agent settings');
    deps.runtime.invalidate(consultant.id);
    agent.invalidate(consultant.id);
    if (patch.enabled !== undefined) {
      await deps.store.logEvent(consultant.id, 'agent_toggled', next.enabled ? 'AI agent turned on' : 'AI agent turned off');
    }
    res.json({ settings: next });
  });

  router.post('/connection', async (req, res) => {
    const { consultant, user } = owned(req);
    const { agent, agentStore } = requireAgent(deps);
    if (!(await planOf(deps, user.id)).agent) throw planRequired('agent', 'Connecting a store is part of the Pro plan');
    const body = parse(connectSchema, req.body ?? {});
    let storeUrl: string;
    try {
      storeUrl = normalizeStoreUrl(body.platform, body.storeUrl);
    } catch (err) {
      throw badRequest(errorMessage(err));
    }
    // A custom API is signed with a secret we generate; keep it if the endpoint is only being updated.
    let creds: StoreCredentials;
    let secret: string | null = null;
    if (body.platform === 'shopify') creds = { platform: 'shopify', accessToken: body.accessToken };
    else if (body.platform === 'woocommerce') creds = { platform: 'woocommerce', consumerKey: body.consumerKey, consumerSecret: body.consumerSecret };
    else {
      const existing = await agentStore.getConnection(consultant.id);
      const previous = existing?.platform === 'custom' ? (agent.credentials(existing) as { secret?: string }).secret : undefined;
      secret = previous ?? `gcs_${randomToken(24)}`;
      creds = { platform: 'custom', secret };
    }

    // Check the credentials against the store before saving them. A custom API may not be
    // written yet: then it is saved with the problem shown, so the developer gets the secret.
    let info: { name: string | null; currency: string | null } = { name: null, currency: null };
    let problem: string | null = null;
    try {
      const connector = deps.agentConnector
        ? deps.agentConnector(body.platform, storeUrl, creds)
        : createConnector(body.platform, storeUrl, creds);
      info = await connector.verify();
    } catch (err) {
      problem = err instanceof StoreError ? err.message : errorMessage(err);
      if (body.platform !== 'custom') throw badRequest(problem);
    }

    const saved = await agentStore.saveConnection({
      consultant_id: consultant.id,
      platform: body.platform,
      store_url: storeUrl,
      store_name: info.name,
      currency: info.currency,
      credentials_ciphertext: encryptSecret(JSON.stringify(creds), deps.config.encryptionKey),
      status: problem ? 'error' : 'connected',
      last_error: problem,
    });
    agent.invalidate(consultant.id);
    deps.runtime.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, 'store_connected', `Store connected: ${info.name ?? storeUrl} (${body.platform})`);
    res.status(201).json({
      connection: connectionView(saved),
      secret,
      notifyUrl: body.platform === 'custom' && deps.config.publicUrl ? `${deps.config.publicUrl}/api/hooks/store/${saved.id}/notify` : null,
    });
  });

  /** The signing secret of a custom API, for the site's developer. */
  router.get('/connection/secret', async (req, res) => {
    const { consultant } = owned(req);
    const { agent } = requireAgent(deps);
    const connection = await agent.connection(consultant.id);
    if (connection?.platform !== 'custom') throw new AppError(404, 'not_found', 'No custom API is connected');
    res.json({ secret: (agent.credentials(connection) as { secret?: string }).secret ?? null });
  });

  router.delete('/connection', async (req, res) => {
    const { consultant } = owned(req);
    const { agent, agentStore } = requireAgent(deps);
    await agentStore.deleteConnection(consultant.id);
    agent.invalidate(consultant.id);
    await deps.store.logEvent(consultant.id, 'store_disconnected', 'Store disconnected');
    res.status(204).end();
  });

  router.get('/actions', async (req, res) => {
    const { consultant, db } = owned(req);
    const { agentStore } = requireAgent(deps);
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const actions = await agentStore.listActions(consultant.id, limit);
    const ids = [...new Set(actions.map((a) => a.conversation_id).filter((id): id is string => Boolean(id)))];
    const conversations = new Map<string, Pick<ConversationRow, 'id' | 'customer_name' | 'channel'>>();
    if (ids.length) {
      const { data, error } = await db.from('conversations').select('id, customer_name, channel').in('id', ids);
      if (error) throw dbError(error, 'loading conversations');
      for (const c of (data ?? []) as Pick<ConversationRow, 'id' | 'customer_name' | 'channel'>[]) conversations.set(c.id, c);
    }
    res.json({ actions: actions.map((a) => actionView(a, a.conversation_id ? conversations.get(a.conversation_id) : undefined)) });
  });

  const decide = (approve: boolean) => async (req: Request, res: Response) => {
    const { consultant } = owned(req);
    const { agent } = requireAgent(deps);
    const actionId = parse(uuidParam, req.params.actionId);
    const conversation = await findActionConversation(deps, consultant, actionId);
    const lang = conversation ? await conversationLang(deps.store, conversation) : 'en';
    const outcome = approve
      ? await agent.approve(consultant, actionId, lang)
      : await agent.reject(consultant, actionId, lang, parse(rejectSchema, req.body ?? {}).reason);
    let delivered = false;
    if (conversation) {
      delivered = await deps.runtime.notifyCustomer(consultant.id, conversation.id, outcome.message).catch(() => false);
      await deps.admin.from('conversations').update({ needs_attention: false, attention_reason: null }).eq('id', conversation.id);
    }
    await deps.store.logEvent(consultant.id, approve ? 'agent_action_approved' : 'agent_action_rejected', `${approve ? 'Approved' : 'Declined'}: ${outcome.action.summary.slice(0, 200)}`);
    res.json({ action: actionView(outcome.action, conversation ?? undefined), delivered });
  };
  router.post('/actions/:actionId/approve', decide(true));
  router.post('/actions/:actionId/reject', decide(false));

  return router;
}

async function findActionConversation(deps: AppDeps, consultant: ConsultantRow, actionId: string): Promise<ConversationRow | null> {
  const action = await deps.agentStore!.getAction(actionId);
  if (!action || action.consultant_id !== consultant.id || !action.conversation_id) return null;
  return deps.store.getConversation(action.conversation_id);
}
