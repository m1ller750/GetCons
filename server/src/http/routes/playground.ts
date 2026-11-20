import { Router } from 'express';
import { z } from 'zod';
import type { ConversationRow } from '../../db/types.js';
import { dbError } from '../../lib/errors.js';
import { owned, type AppDeps } from '../deps.js';
import { parse } from '../middleware.js';

const sendSchema = z.object({ text: z.string().trim().min(1).max(4000) });

export function playgroundRouter(deps: AppDeps): Router {
  const router = Router({ mergeParams: true });

  async function findConversation(req: Parameters<typeof owned>[0]): Promise<ConversationRow | null> {
    const { consultant, db } = owned(req);
    const { data, error } = await db
      .from('conversations')
      .select('*')
      .eq('consultant_id', consultant.id)
      .eq('channel', 'playground')
      .eq('external_chat_id', 0)
      .maybeSingle();
    if (error) throw dbError(error, 'loading test chat');
    return (data as ConversationRow | null) ?? null;
  }

  router.get('/', async (req, res) => {
    const { db } = owned(req);
    const conversation = await findConversation(req);
    if (!conversation) {
      res.json({ messages: [] });
      return;
    }
    let query = db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(100);
    if (conversation.memory_reset_at) query = query.gt('created_at', conversation.memory_reset_at);
    const { data, error } = await query;
    if (error) throw dbError(error, 'loading test chat');
    res.json({ messages: (data ?? []).reverse() });
  });

  router.post('/', async (req, res) => {
    const { consultant } = owned(req);
    const { text } = parse(sendSchema, req.body ?? {});
    const { reply, message } = await deps.runtime.playground(consultant.id, text);
    res.json({ message, status: reply.status, meta: reply.meta, needsAttention: reply.needsAttention, attentionReason: reply.attentionReason });
  });

  router.post('/reset', async (req, res) => {
    const { consultant } = owned(req);
    const conversation = await findConversation(req);
    if (conversation) {
      const { error } = await deps.admin
        .from('conversations')
        .update({ memory_reset_at: new Date().toISOString(), summary: null, summarized_until: null })
        .eq('id', conversation.id)
        .eq('consultant_id', consultant.id);
      if (error) throw dbError(error, 'resetting test chat');
    }
    res.json({ ok: true });
  });

  return router;
}
