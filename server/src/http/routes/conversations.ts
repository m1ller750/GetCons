import { Router } from 'express';
import { z } from 'zod';
import type { ConversationRow, MessageRow } from '../../db/types.js';
import { badRequest, dbError, notFound } from '../../lib/errors.js';
import { owned, type AppDeps } from '../deps.js';
import { parse, uuidParam } from '../middleware.js';
import { sanitizeSearch } from './examples.js';

const PAGE_SIZE = 30;
/** Real customer chats; the dashboard test chat is "playground". */
const CUSTOMER_CHANNELS = ['telegram', 'whatsapp'];

const listQuery = z.object({
  q: z.string().trim().max(200).optional(),
  filter: z.enum(['all', 'attention', 'ai_off']).default('all'),
  channel: z.enum(['telegram', 'whatsapp']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const messagesQuery = z.object({
  before: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
});

const patchSchema = z
  .object({
    ai_enabled: z.boolean(),
    needs_attention: z.boolean(),
  })
  .partial();

const replySchema = z.object({ text: z.string().trim().min(1).max(4000) });

export function conversationsRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  async function loadConversation(req: Parameters<typeof owned>[0], idParam: unknown): Promise<ConversationRow> {
    const { consultant, db } = owned(req);
    const id = parse(uuidParam, idParam);
    const { data, error } = await db
      .from('conversations')
      .select('*')
      .eq('id', id)
      .eq('consultant_id', consultant.id)
      .in('channel', CUSTOMER_CHANNELS)
      .maybeSingle();
    if (error) throw dbError(error, 'loading conversation');
    if (!data) throw notFound('Conversation');
    return data as ConversationRow;
  }

  router.get('/', async (req, res) => {
    const { consultant, db } = owned(req);
    const { q, filter, channel, page } = parse(listQuery, req.query);
    let query = db
      .from('conversations')
      .select('*', { count: 'exact' })
      .eq('consultant_id', consultant.id)
      .in('channel', channel ? [channel] : CUSTOMER_CHANNELS)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
    if (filter === 'attention') query = query.eq('needs_attention', true);
    if (filter === 'ai_off') query = query.eq('ai_enabled', false);
    const term = q ? sanitizeSearch(q) : '';
    if (term) {
      query = query.or(
        `customer_name.ilike.*${term}*,customer_username.ilike.*${term}*,last_message_preview.ilike.*${term}*`,
      );
    }
    const { data, error, count } = await query;
    if (error) throw dbError(error, 'listing conversations');
    res.json({ conversations: data ?? [], total: count ?? 0, page, pageSize: PAGE_SIZE });
  });

  router.get('/:conversationId', async (req, res) => {
    const { db } = owned(req);
    const conversation = await loadConversation(req, req.params.conversationId);
    const { before, limit } = parse(messagesQuery, req.query);
    let query = db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(limit + 1);
    if (before) query = query.lt('created_at', before);
    const { data, error } = await query;
    if (error) throw dbError(error, 'loading messages');
    const rows = (data ?? []) as MessageRow[];
    const hasMore = rows.length > limit;
    res.json({ conversation, messages: rows.slice(0, limit).reverse(), hasMore });
  });

  router.patch('/:conversationId', async (req, res) => {
    const { consultant } = owned(req);
    const conversation = await loadConversation(req, req.params.conversationId);
    const body = parse(patchSchema, req.body ?? {});
    if (!Object.keys(body).length) throw badRequest('Nothing to update');
    const patch: Partial<ConversationRow> = { ...body };
    if (body.needs_attention === false) patch.attention_reason = null;
    const { data, error } = await deps.admin
      .from('conversations')
      .update(patch)
      .eq('id', conversation.id)
      .eq('consultant_id', consultant.id)
      .select('*')
      .single();
    if (error) throw dbError(error, 'updating conversation');
    if (body.ai_enabled !== undefined) {
      await deps.store.logEvent(
        consultant.id,
        body.ai_enabled ? 'ai_resumed_chat' : 'ai_paused_chat',
        `${body.ai_enabled ? 'AI resumed' : 'AI paused (human takeover)'} for ${conversation.customer_name ?? 'a customer'}`,
        { meta: { conversation_id: conversation.id } },
      );
    }
    res.json({ conversation: data });
  });

  // Human reply from the dashboard, delivered by the consultant's bot.
  router.post('/:conversationId/messages', async (req, res) => {
    const { consultant, user } = owned(req);
    const conversation = await loadConversation(req, req.params.conversationId);
    const { text } = parse(replySchema, req.body ?? {});
    const message = await deps.runtime.sendOperatorMessage(consultant.id, conversation.id, text, user.email);
    res.status(201).json({ message });
  });

  router.post('/:conversationId/reset-memory', async (req, res) => {
    const { consultant } = owned(req);
    const conversation = await loadConversation(req, req.params.conversationId);
    const { error } = await deps.admin
      .from('conversations')
      .update({ memory_reset_at: new Date().toISOString() })
      .eq('id', conversation.id)
      .eq('consultant_id', consultant.id);
    if (error) throw dbError(error, 'resetting memory');
    res.json({ ok: true });
  });

  router.delete('/:conversationId', async (req, res) => {
    const { consultant } = owned(req);
    const conversation = await loadConversation(req, req.params.conversationId);
    const { error } = await deps.admin
      .from('conversations')
      .delete()
      .eq('id', conversation.id)
      .eq('consultant_id', consultant.id);
    if (error) throw dbError(error, 'deleting conversation');
    res.status(204).end();
  });

  return router;
}
